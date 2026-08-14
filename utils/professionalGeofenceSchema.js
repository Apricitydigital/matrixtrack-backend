const pool = require("../config/db");

let schemaPromise = null;

const ensureProfessionalGeofenceSchema = async () => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_geofence_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
            city_id INTEGER REFERENCES cities(city_id) ON DELETE SET NULL,
            zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
            ward_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL,
            kothi_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
            request_latitude DOUBLE PRECISION NOT NULL,
            request_longitude DOUBLE PRECISION NOT NULL,
            request_address TEXT,
            request_note TEXT,
            request_radius_meters INTEGER NOT NULL DEFAULT 150,
            status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
            rejection_reason TEXT,
            reviewed_by INTEGER REFERENCES users(user_id),
            reviewed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_geofence_req_prof_status
          ON professional_geofence_requests (professional_id, status, created_at DESC)
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_geofence_req_scope
          ON professional_geofence_requests (city_id, zone_id, ward_id, kothi_id, status, created_at DESC)
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_geofences (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
            city_id INTEGER REFERENCES cities(city_id) ON DELETE SET NULL,
            zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
            ward_id INTEGER REFERENCES sectors(sector_id) ON DELETE SET NULL,
            kothi_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
            latitude DOUBLE PRECISION NOT NULL,
            longitude DOUBLE PRECISION NOT NULL,
            radius_meters INTEGER NOT NULL DEFAULT 150,
            source_request_id UUID REFERENCES professional_geofence_requests(id) ON DELETE SET NULL,
            approved_by INTEGER REFERENCES users(user_id),
            approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            deactivated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await client.query(`
          DROP INDEX IF EXISTS uidx_prof_geofence_one_active
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_geofence_scope_active
          ON professional_geofences (city_id, zone_id, ward_id, kothi_id, is_active, approved_at DESC)
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_geofence_prof_active
          ON professional_geofences (professional_id, is_active, approved_at DESC)
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_geofence_request_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL REFERENCES professional_geofence_requests(id) ON DELETE CASCADE,
            professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
            action VARCHAR(24) NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected')),
            actor_type VARCHAR(16) NOT NULL CHECK (actor_type IN ('professional', 'supervisor', 'admin', 'system')),
            actor_user_id INTEGER REFERENCES users(user_id),
            note TEXT,
            metadata JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_geofence_logs_request
          ON professional_geofence_request_logs (request_id, created_at DESC)
        `);

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }

  return schemaPromise;
};

module.exports = {
  ensureProfessionalGeofenceSchema,
};
