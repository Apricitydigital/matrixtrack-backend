/**
 * Migration: Add auto_punched_out column to attendance table
 * Run once on startup — safe to run multiple times (uses IF NOT EXISTS logic).
 */

const pool = require("../config/db");

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log("[Migration] Running auto punch-out migrations...");

    // Add auto_punched_out boolean column (default false)
    await client.query(`
      ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS auto_punched_out BOOLEAN DEFAULT false
    `);
    console.log("[Migration] ✅ auto_punched_out column ready.");

    // Add updated_at column if not present (for tracking when record was modified)
    await client.query(`
      ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NULL
    `);
    console.log("[Migration] ✅ updated_at column ready.");

    // Create index on date for faster dashboard queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_date 
      ON attendance(date)
    `);
    console.log("[Migration] ✅ idx_attendance_date index ready.");

    // Create index on punch_out_time for faster auto-punchout and dashboard queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_attendance_punch_out_time 
      ON attendance(punch_out_time)
    `);
    console.log("[Migration] ✅ idx_attendance_punch_out_time index ready.");

    console.log("[Migration] ✅ All migrations complete.");
  } catch (err) {
    // Non-fatal: log and continue
    console.error("[Migration] ❌ Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
