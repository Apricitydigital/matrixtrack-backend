/**
 * Migration Runner — runs on every startup.
 * All migrations use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS and are idempotent.
 */

const pool = require("../config/db");
const fs = require("fs");
const path = require("path");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");
const { ensureProfessionalPushSchema } = require("../utils/professionalPushService");
const { ensureRbacSchema } = require("../utils/rbacSetup");

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
    await ensureProfessionalPushSchema(client);
    console.log("[Migration] Professional push schema ready.");

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

    // ── Soft Delete columns on users table ──────────────────────────────────
    console.log("[Migration] Running Admin Soft Delete migration...");
    const softDeleteSqlPath = path.join(__dirname, "migrations", "20260623_soft_delete_admins.sql");
    if (fs.existsSync(softDeleteSqlPath)) {
      const softDeleteSql = fs.readFileSync(softDeleteSqlPath, "utf8");
      await client.query(softDeleteSql);
      console.log("[Migration] Admin soft delete columns ready.");
    } else {
      console.warn("[Migration] Soft delete SQL file not found at:", softDeleteSqlPath);
    }

    // ── Supervisor Transfer History table ────────────────────────────────────
    console.log("[Migration] Running Supervisor Transfer History migration...");
    const supTransferSqlPath = path.join(__dirname, "migrations", "20260526_supervisor_migration_history.sql");
    if (fs.existsSync(supTransferSqlPath)) {
      const supTransferSql = fs.readFileSync(supTransferSqlPath, "utf8");
      await client.query(supTransferSql);
      console.log("[Migration] Supervisor Transfer History table ready.");
    } else {
      console.warn("[Migration] Supervisor Transfer History SQL file not found at:", supTransferSqlPath);
    }

    // ── Attendance time schema alignment ─────────────────────────────────────
    console.log("[Migration] Running Attendance time schema alignment...");
    const attendTimeSqlPath = path.join(__dirname, "migrations", "20260528_attendance_time_schema_alignment.sql");
    if (fs.existsSync(attendTimeSqlPath)) {
      const attendTimeSql = fs.readFileSync(attendTimeSqlPath, "utf8");
      await client.query(attendTimeSql);
      console.log("[Migration] Attendance time schema alignment ready.");
    } else {
      console.warn("[Migration] Attendance time schema alignment SQL not found at:", attendTimeSqlPath);
    }

    console.log("[Migration] All migrations complete.");
  } catch (err) {
    console.error("[Migration] Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }

  // ── RBAC Schema & Permissions Seeding ───────────────────────────────────────
  // Runs outside the client block since ensureRbacSchema manages its own connection.
  try {
    await ensureRbacSchema();
    console.log("[Migration] RBAC schema and permissions seeded.");
  } catch (rbacErr) {
    console.error("[Migration] RBAC seeding error (non-fatal):", rbacErr.message);
  }
}

module.exports = { runMigrations };
