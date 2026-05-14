/**
 * Migration: Add auto_punched_out column to attendance table
 * Run once on startup - safe to run multiple times (uses IF NOT EXISTS logic).
 */

const pool = require("../config/db");
const fs = require("fs");
const path = require("path");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log("[Migration] Running auto punch-out migrations...");

    await client.query(`
      ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS auto_punched_out BOOLEAN DEFAULT false
    `);
    console.log("[Migration] auto_punched_out column ready.");

    await client.query(`
      ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NULL
    `);
    console.log("[Migration] updated_at column ready.");

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_date
      ON attendance(date)
    `);
    console.log("[Migration] idx_attendance_date index ready.");

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_punch_out_time
      ON attendance(punch_out_time)
    `);
    console.log("[Migration] idx_attendance_punch_out_time index ready.");

    console.log("[Migration] Running Self Punch-In migrations...");
    const selfPunchInSqlPath = path.join(__dirname, "migrations", "20260505_self_punch_in_up.sql");
    if (fs.existsSync(selfPunchInSqlPath)) {
      const selfPunchInSql = fs.readFileSync(selfPunchInSqlPath, "utf8");
      await client.query(selfPunchInSql);
      console.log("[Migration] Self Punch-In migrations ready.");
    } else {
      console.warn("[Migration] Self Punch-In SQL file not found at:", selfPunchInSqlPath);
    }

    console.log("[Migration] Running Department City linkage migrations...");
    const deptCitySqlPath = path.join(__dirname, "migrations", "20260514_link_department_cities.sql");
    if (fs.existsSync(deptCitySqlPath)) {
      const deptCitySql = fs.readFileSync(deptCitySqlPath, "utf8");
      await client.query(deptCitySql);
      console.log("[Migration] Department City linkage migrations ready.");
    } else {
      console.warn("[Migration] Department City linkage SQL file not found at:", deptCitySqlPath);
    }

    console.log("[Migration] Running Designation City linkage migrations...");
    const desigCitySqlPath = path.join(__dirname, "migrations", "20260514_link_designation_cities.sql");
    if (fs.existsSync(desigCitySqlPath)) {
      const desigCitySql = fs.readFileSync(desigCitySqlPath, "utf8");
      await client.query(desigCitySql);
      console.log("[Migration] Designation City linkage migrations ready.");
    } else {
      console.warn("[Migration] Designation City linkage SQL file not found at:", desigCitySqlPath);
    }

    await ensureProfessionalLeaveSchema();
    console.log("[Migration] Professional leave schema ready.");

    console.log("[Migration] All migrations complete.");
  } catch (err) {
    console.error("[Migration] Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
