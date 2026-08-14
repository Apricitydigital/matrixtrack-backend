const pool = require("../config/db");

let ensurePromise = null;

const ensureProfessionalFeatureSettingsSchema = async () => {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_feature_settings (
            id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            geofence_enforcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            updated_by INTEGER REFERENCES users(user_id),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          INSERT INTO professional_feature_settings (id, geofence_enforcement_enabled)
          VALUES (1, FALSE)
          ON CONFLICT (id) DO NOTHING
        `);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }

  return ensurePromise;
};

const getProfessionalFeatureSettings = async (clientRef = pool) => {
  await ensureProfessionalFeatureSettingsSchema();
  const { rows } = await clientRef.query(
    `SELECT geofence_enforcement_enabled, updated_by, updated_at
     FROM professional_feature_settings
     WHERE id = 1
     LIMIT 1`
  );

  return (
    rows[0] || {
      geofence_enforcement_enabled: false,
      updated_by: null,
      updated_at: null,
    }
  );
};

const setProfessionalGeofenceEnforcement = async ({
  enabled,
  updatedBy = null,
  clientRef = pool,
}) => {
  await ensureProfessionalFeatureSettingsSchema();
  const { rows } = await clientRef.query(
    `INSERT INTO professional_feature_settings (
       id, geofence_enforcement_enabled, updated_by, updated_at
     )
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE
     SET geofence_enforcement_enabled = EXCLUDED.geofence_enforcement_enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
     RETURNING geofence_enforcement_enabled, updated_by, updated_at`,
    [Boolean(enabled), updatedBy]
  );

  return rows[0];
};

module.exports = {
  ensureProfessionalFeatureSettingsSchema,
  getProfessionalFeatureSettings,
  setProfessionalGeofenceEnforcement,
};
