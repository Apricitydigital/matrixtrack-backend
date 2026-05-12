const pool = require("../config/db");

let schemaPromise = null;

const ensureProfessionalLeaveSchema = async () => {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_leave_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
            requested_date DATE NOT NULL,
            leave_type VARCHAR(24) NOT NULL CHECK (leave_type IN ('MEDICAL', 'CASUAL', 'PAID')),
            reason TEXT,
            status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_by INTEGER REFERENCES users(user_id),
            reviewed_at TIMESTAMPTZ,
            review_note TEXT
          )
        `);

        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uidx_prof_leave_prof_date
          ON professional_leave_requests (professional_id, requested_date)
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_leave_status_date
          ON professional_leave_requests (status, requested_date DESC)
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_leave_request_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL REFERENCES professional_leave_requests(id) ON DELETE CASCADE,
            action VARCHAR(24) NOT NULL CHECK (action IN ('submitted', 'approved', 'rejected', 'resubmitted')),
            actor_type VARCHAR(16) NOT NULL CHECK (actor_type IN ('professional', 'supervisor', 'admin', 'system')),
            actor_user_id INTEGER REFERENCES users(user_id),
            actor_professional_id UUID REFERENCES professional_employees(id),
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_leave_logs_request
          ON professional_leave_request_logs (request_id, created_at DESC)
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS professional_notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
            type VARCHAR(40) NOT NULL,
            title VARCHAR(160) NOT NULL,
            message TEXT NOT NULL,
            metadata JSONB DEFAULT '{}'::jsonb,
            is_read BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);

        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_prof_notifications_prof_read
          ON professional_notifications (professional_id, is_read, created_at DESC)
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
  ensureProfessionalLeaveSchema,
};
