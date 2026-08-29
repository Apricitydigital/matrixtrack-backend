/**
 * Migration: Add auto_punched_out column to attendance table
 * Run once on startup - safe to run multiple times (uses IF NOT EXISTS logic).
 */

const pool = require("../config/db");
const fs = require("fs");
const path = require("path");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");
const { ensureProfessionalPushSchema } = require("../utils/professionalPushService");

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

    // Add permissions column to users table for granular admin control
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT NULL
    `);
    console.log("[Migration] ✅ users permissions column ready.");

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL
    `);
    await client.query(`
      UPDATE users
      SET is_deleted = FALSE
      WHERE is_deleted IS NULL
    `);
    console.log("[Migration] ✅ users soft delete columns ready.");

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

    console.log("[Migration] Running City Traffic Cost migrations...");
    const cityCostSqlPath = path.join(__dirname, "migrations", "20260709_create_city_traffic_cost_tables.sql");
    if (fs.existsSync(cityCostSqlPath)) {
      const cityCostSql = fs.readFileSync(cityCostSqlPath, "utf8");
      await client.query(cityCostSql);
      console.log("[Migration] City Traffic Cost migrations ready.");
    } else {
      console.warn("[Migration] City Traffic Cost SQL file not found at:", cityCostSqlPath);
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

    // Add blocked_ips table for IP blocking feature
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_ips (
        ip_address VARCHAR(45) PRIMARY KEY,
        blocked_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        reason TEXT,
        blocked_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("[Migration] ✅ blocked_ips table ready.");

    // Add active_sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        token_hash VARCHAR(128) NOT NULL,
        ip_address VARCHAR(45),
        device TEXT,
        logged_in_at TIMESTAMP DEFAULT NOW(),
        is_revoked BOOLEAN DEFAULT FALSE,
        revoked_by INTEGER,
        revoked_at TIMESTAMP,
        last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_active_sessions_hash ON active_sessions(token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_active_sessions_revoked ON active_sessions(is_revoked)`);
    console.log("[Migration] ✅ active_sessions table ready.");

    // Add security_settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS security_settings (
        id INT PRIMARY KEY,
        admin_login_mode VARCHAR(20) DEFAULT 'multiple',
        admin_max_devices INT DEFAULT 10,
        supervisor_login_mode VARCHAR(20) DEFAULT 'multiple',
        supervisor_max_devices INT DEFAULT 10,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      INSERT INTO security_settings (id, admin_login_mode, admin_max_devices, supervisor_login_mode, supervisor_max_devices)
      VALUES (1, 'multiple', 10, 'multiple', 10)
      ON CONFLICT (id) DO NOTHING
    `);
    console.log("[Migration] ✅ security_settings table ready.");

    // Add 2FA and login policy columns to users table
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_otp VARCHAR(10)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_otp_expiry TIMESTAMP`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_login_policy VARCHAR(50) DEFAULT NULL`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_max_devices INTEGER DEFAULT NULL`);
    console.log("[Migration] ✅ users 2FA and login policy columns ready.");

    console.log("[Migration] All migrations complete.");
  } catch (err) {
    console.error("[Migration] Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
