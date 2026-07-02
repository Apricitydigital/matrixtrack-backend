#!/usr/bin/env node
/* eslint-disable no-console */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("../config/db");
const { ensureRbacSchema } = require("../utils/rbacSetup");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const SKIP_FILES = process.argv
  .filter((arg) => arg.startsWith("--skip="))
  .map((arg) => arg.slice("--skip=".length))
  .filter(Boolean);

const FORBIDDEN_PATTERNS = [
  /^\s*DELETE\b/i,
  /^\s*TRUNCATE\b/i,
  /^\s*DROP\s+TABLE\b/i,
  /^\s*DROP\s+SCHEMA\b/i,
  /^\s*DROP\s+DATABASE\b/i,
];

const normalizeSql = (sql) => String(sql || "").replace(/\r\n/g, "\n");

const hashSql = (sql) =>
  crypto.createHash("sha256").update(normalizeSql(sql), "utf8").digest("hex");

function splitSqlStatements(sqlText) {
  const sql = normalizeSql(sqlText);
  const statements = [];
  let current = "";
  let i = 0;

  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && !dollarTag && ch === "-" && next === "-") {
      inLineComment = true;
      current += ch + next;
      i += 2;
      continue;
    }

    if (!inSingle && !inDouble && !dollarTag && ch === "/" && next === "*") {
      inBlockComment = true;
      current += ch + next;
      i += 2;
      continue;
    }

    if (!inDouble && !dollarTag && ch === "'") {
      inSingle = !inSingle;
      current += ch;
      i += 1;
      continue;
    }

    if (!inSingle && !dollarTag && ch === "\"") {
      inDouble = !inDouble;
      current += ch;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && ch === "$") {
      const match = sql.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (match) {
        const tag = match[0];
        if (!dollarTag) {
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
        if (dollarTag === tag) {
          dollarTag = null;
          current += tag;
          i += tag.length;
          continue;
        }
      }
    }

    if (!inSingle && !inDouble && !dollarTag && ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

const isForbiddenStatement = (statement) =>
  FORBIDDEN_PATTERNS.some((pattern) => pattern.test(statement));

const shouldIgnoreDbError = (statement, error) => {
  const sql = String(statement || "").trim().toUpperCase();
  const code = String(error?.code || "");

  // duplicate_object: trigger/constraint/function/type already exists
  if (code === "42710") return true;

  // duplicate_table: table/index/sequence already exists
  if (
    code === "42P07" &&
    (sql.startsWith("CREATE TABLE") ||
      sql.startsWith("CREATE INDEX") ||
      sql.startsWith("CREATE UNIQUE INDEX") ||
      sql.startsWith("CREATE SEQUENCE"))
  ) {
    return true;
  }

  // duplicate_column
  if (code === "42701" && sql.startsWith("ALTER TABLE")) return true;

  return false;
};

async function ensureMigrationLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations_safe (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'applied',
      details TEXT,
      UNIQUE (filename, checksum)
    )
  `);
}

async function alreadyApplied(filename, checksum) {
  const { rows } = await pool.query(
    `
      SELECT 1
      FROM schema_migrations_safe
      WHERE filename = $1 AND checksum = $2 AND status = 'applied'
      LIMIT 1
    `,
    [filename, checksum]
  );
  return rows.length > 0;
}

async function markApplied(filename, checksum, status, details = null) {
  await pool.query(
    `
      INSERT INTO schema_migrations_safe (filename, checksum, status, details)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (filename, checksum) DO UPDATE
      SET status = EXCLUDED.status,
          details = EXCLUDED.details,
          applied_at = NOW()
    `,
    [filename, checksum, status, details]
  );
}

async function run() {
  console.log(`\n[structure-migrate] Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log(`[structure-migrate] Force mode: ${FORCE ? "YES" : "NO"}`);
  if (SKIP_FILES.length > 0) {
    console.log(`[structure-migrate] Skip files: ${SKIP_FILES.join(", ")}`);
  }
  console.log("[structure-migrate] Delete/truncate/drop-table/schema/database statements are blocked.\n");

  await ensureMigrationLogTable();

  const allFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => !name.toLowerCase().includes("_down"))
    .filter((name) => !SKIP_FILES.includes(name))
    .sort((a, b) => a.localeCompare(b));

  for (const filename of allFiles) {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filePath, "utf8");
    const checksum = hashSql(sql);
    const statements = splitSqlStatements(sql);

    if (!FORCE && (await alreadyApplied(filename, checksum))) {
      console.log(`[skip] ${filename} (already applied)`);
      continue;
    }

    console.log(`[run] ${filename} (${statements.length} statements)`);

    const skipped = [];
    const ignoredErrors = [];
    let executed = 0;

    const client = await pool.connect();
    try {
      if (!DRY_RUN) {
        await client.query("SET statement_timeout = 0");
      }
      for (const statement of statements) {
        if (isForbiddenStatement(statement)) {
          skipped.push(statement.split("\n")[0].slice(0, 160));
          continue;
        }
        if (!DRY_RUN) {
          try {
            await client.query(statement);
          } catch (error) {
            if (shouldIgnoreDbError(statement, error)) {
              ignoredErrors.push(
                `${error.code || "N/A"}: ${statement.split("\n")[0].slice(0, 160)}`
              );
              continue;
            }
            throw error;
          }
        }
        executed += 1;
      }

      if (!DRY_RUN) {
        await markApplied(
          filename,
          checksum,
          "applied",
          skipped.length > 0 ? `Skipped ${skipped.length} forbidden statements.` : null
        );
      } else {
        await markApplied(
          filename,
          checksum,
          "dry_run",
          skipped.length > 0 ? `Dry run. Skipped ${skipped.length} forbidden statements.` : "Dry run only."
        );
      }

      console.log(
        `  -> executed: ${executed}, skipped(forbidden): ${skipped.length}, ignored(existing): ${ignoredErrors.length}`
      );
    } catch (error) {
      await markApplied(filename, checksum, "failed", error.message);
      throw new Error(`${filename} failed: ${error.message}`);
    } finally {
      client.release();
    }
  }

  console.log("\n[structure-migrate] Running runtime schema ensure hooks...");
  if (!DRY_RUN) {
    await ensureRbacSchema();
    await ensureProfessionalLeaveSchema();
  }
  console.log("[structure-migrate] Done.");
}

run()
  .catch((error) => {
    console.error("[structure-migrate] Error:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {
      // ignore
    }
  });
