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
      ALTER TABLE attendance
      ADD COLUMN IF NOT EXISTS mid_shift_punch_in_time TIMESTAMPTZ DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS latitude_mid_in VARCHAR(100) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS longitude_mid_in VARCHAR(100) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS mid_in_address TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS mid_shift_punch_in_image TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS mid_shift_punched_in_by INTEGER DEFAULT NULL
    `);
    console.log("[Migration] mid shift punch columns ready.");

    // Create index on date for faster dashboard queries
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
    console.log("[Migration] ✅ employee_transfer_history table ready.");

    await client.query(`
      CREATE TABLE IF NOT EXISTS supervisor_transfer_history (
        transfer_id BIGSERIAL PRIMARY KEY,
        supervisor_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        supervisor_emp_code VARCHAR(120),
        supervisor_name VARCHAR(255),
        from_city_id INTEGER REFERENCES cities(city_id) ON DELETE SET NULL,
        from_city_name VARCHAR(255),
        from_zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
        from_zone_name VARCHAR(255),
        from_sector_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL,
        from_sector_name VARCHAR(255),
        from_kothi_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
        from_kothi_name VARCHAR(255),
        to_city_id INTEGER REFERENCES cities(city_id) ON DELETE SET NULL,
        to_city_name VARCHAR(255),
        to_zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
        to_zone_name VARCHAR(255),
        to_sector_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL,
        to_sector_name VARCHAR(255),
        to_kothi_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
        to_kothi_name VARCHAR(255),
        transfer_mode VARCHAR(40) NOT NULL,
        transfer_batch_id UUID NOT NULL,
        transfer_key_name VARCHAR(120) NOT NULL,
        transferred_by_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        transferred_by_name VARCHAR(255),
        transferred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("[Migration] ✅ supervisor_transfer_history table ready.");

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
      CREATE INDEX IF NOT EXISTS idx_employee_transfer_history_at
      ON employee_transfer_history(transferred_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_supervisor_transfer_history_sup
      ON supervisor_transfer_history(supervisor_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_supervisor_transfer_history_batch
      ON supervisor_transfer_history(transfer_batch_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_supervisor_transfer_history_at
      ON supervisor_transfer_history(transferred_at DESC)
    `);

    await client.query(`
      ALTER TABLE employee_transfer_keys
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    const existingKeyCountResult = await client.query(
      "SELECT COUNT(*)::int AS total FROM employee_transfer_keys"
    );
    const existingKeyCount = existingKeyCountResult.rows[0]?.total || 0;
    if (existingKeyCount === 0) {
      const defaultKeyHash = await bcrypt.hash("jasikey", 10);
      await client.query(
        `INSERT INTO employee_transfer_keys (key_name, key_hash, is_active)
         VALUES ($1, $2, true)`,
        ["jasikey", defaultKeyHash]
      );
      console.log("[Migration] ✅ Default transfer key 'jasikey' seeded.");
    }

    console.log("[Migration] All migrations complete.");
  } catch (err) {
    console.error("[Migration] Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
