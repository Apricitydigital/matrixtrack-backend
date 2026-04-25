/**
 * Migration: Add is_auto_punch_out column to attendance table
 * Safe to run multiple times (uses IF NOT EXISTS guard).
 *
 * Run with: node migrate-auto-punchout.js
 */

require("dotenv").config();
const pool = require("./config/db");

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("[Migration] Starting auto-punchout column migration...");

    await client.query(`
      ALTER TABLE attendance
        ADD COLUMN IF NOT EXISTS is_auto_punch_out BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    console.log("[Migration] ✅ Column 'is_auto_punch_out' ensured on attendance table.");

    // Verify
    const result = await client.query(`
      SELECT column_name, data_type, column_default
        FROM information_schema.columns
       WHERE table_name = 'attendance'
         AND column_name = 'is_auto_punch_out';
    `);
    if (result.rows.length > 0) {
      console.log("[Migration] ✅ Verified:", result.rows[0]);
    } else {
      console.warn("[Migration] ⚠️  Column not found after migration — check DB permissions.");
    }

    console.log("[Migration] Done.");
  } catch (err) {
    console.error("[Migration] ❌ Error:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
