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

    await ensureProfessionalLeaveSchema();
    console.log("[Migration] Professional leave schema ready.");

    // ── emp_code columns ────────────────────────────────────────────────────
    await client.query(`
      ALTER TABLE self_punch_requests
        ADD COLUMN IF NOT EXISTS emp_code VARCHAR(50)
    `);
    await client.query(`
      ALTER TABLE professional_employees
        ADD COLUMN IF NOT EXISTS emp_code VARCHAR(50)
    `);
    console.log("[Migration] emp_code columns ready.");

    // ── Leave allocation tables ─────────────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS professional_leave_allocations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
        leave_type VARCHAR(24) NOT NULL CHECK (leave_type IN ('MEDICAL','CASUAL','PAID')),
        period VARCHAR(16) NOT NULL CHECK (period IN ('monthly','quarterly','half_yearly','yearly')),
        allocated_count INTEGER NOT NULL DEFAULT 0 CHECK (allocated_count >= 0),
        created_by INTEGER REFERENCES users(user_id),
        updated_by INTEGER REFERENCES users(user_id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (professional_id, leave_type, period)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS professional_week_off (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        professional_id UUID UNIQUE NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
        week_off_days INTEGER[] NOT NULL DEFAULT '{}',
        created_by INTEGER REFERENCES users(user_id),
        updated_by INTEGER REFERENCES users(user_id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS professional_leave_allocation_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
        actor_user_id INTEGER REFERENCES users(user_id),
        actor_name TEXT,
        change_summary TEXT NOT NULL,
        old_values JSONB,
        new_values JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prof_leave_alloc_prof
      ON professional_leave_allocations (professional_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_prof_leave_alloc_logs_prof
      ON professional_leave_allocation_logs (professional_id, created_at DESC)
    `);
    console.log("[Migration] Leave allocation tables ready.");

    console.log("[Migration] All migrations complete.");
  } catch (err) {
    console.error("[Migration] Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
