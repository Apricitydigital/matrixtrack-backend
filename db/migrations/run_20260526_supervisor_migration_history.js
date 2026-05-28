require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("../../config/db");

async function run() {
  const client = await pool.connect();
  try {
    const sqlPath = path.join(
      __dirname,
      "20260526_supervisor_migration_history.sql"
    );
    const sql = fs.readFileSync(sqlPath, "utf8");

    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");

    console.log("[Migration] 20260526_supervisor_migration_history applied.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      "[Migration] 20260526_supervisor_migration_history failed:",
      error.message
    );
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();

