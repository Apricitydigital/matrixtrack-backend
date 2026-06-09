/**
 * Migration: Add auto_punched_out column to attendance table
 * Run once on startup - safe to run multiple times (uses IF NOT EXISTS logic).
 */

const pool = require("../config/db");
<<<<<<< HEAD
const fs = require("fs");
const path = require("path");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");
=======
const bcrypt = require("bcryptjs");
>>>>>>> 3707dc890351e4da0658adc94ac0e8e684a793af

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

<<<<<<< HEAD
=======
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
>>>>>>> 3707dc890351e4da0658adc94ac0e8e684a793af
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

<<<<<<< HEAD
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
=======
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_transfer_keys (
        key_id SERIAL PRIMARY KEY,
        key_name VARCHAR(120) UNIQUE NOT NULL,
        key_hash TEXT NOT NULL,
        created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log("[Migration] ✅ employee_transfer_keys table ready.");

    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await client.query(`
      CREATE OR REPLACE FUNCTION create_employee_transfer_key(
        p_key_name TEXT,
        p_key_value TEXT,
        p_created_by INTEGER DEFAULT NULL,
        p_is_active BOOLEAN DEFAULT TRUE
      )
      RETURNS employee_transfer_keys
      LANGUAGE plpgsql
      AS $$
      DECLARE
        inserted_row employee_transfer_keys;
      BEGIN
        IF p_key_name IS NULL OR btrim(p_key_name) = '' THEN
          RAISE EXCEPTION 'p_key_name is required';
        END IF;

        IF p_key_value IS NULL OR length(p_key_value) < 4 THEN
          RAISE EXCEPTION 'p_key_value must be at least 4 characters';
        END IF;

        INSERT INTO employee_transfer_keys (key_name, key_hash, created_by, is_active)
        VALUES (btrim(p_key_name), crypt(p_key_value, gen_salt('bf', 10)), p_created_by, p_is_active)
        RETURNING * INTO inserted_row;

        RETURN inserted_row;
      END;
      $$;
    `);
    console.log("[Migration] ✅ create_employee_transfer_key() helper ready.");

    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_transfer_history (
        transfer_id BIGSERIAL PRIMARY KEY,
        emp_id INTEGER NOT NULL REFERENCES employee(emp_id) ON DELETE CASCADE,
        emp_code VARCHAR(120),
        employee_name VARCHAR(255),
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
      CREATE INDEX IF NOT EXISTS idx_employee_transfer_history_emp
      ON employee_transfer_history(emp_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_transfer_history_batch
      ON employee_transfer_history(transfer_batch_id)
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

    console.log("[Migration] ✅ All migrations complete.");
>>>>>>> 3707dc890351e4da0658adc94ac0e8e684a793af
  } catch (err) {
    console.error("[Migration] Migration error (non-fatal):", err.message);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
