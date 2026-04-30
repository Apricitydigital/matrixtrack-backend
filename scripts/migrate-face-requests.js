/**
 * Migration: Create face_recapture_requests and admin_notifications tables.
 *
 * Run once:  node scripts/migrate-face-requests.js
 *
 * Both tables are guarded with "IF NOT EXISTS" so re-running is safe.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const pool = require("../config/db");

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── face_recapture_requests ──────────────────────────────────────────────
    // Tracks the full lifecycle of a face re-capture request.
    // status values: REQUESTED | APPROVED | REJECTED | UPDATED
    await client.query(`
      CREATE TABLE IF NOT EXISTS face_recapture_requests (
        id               SERIAL PRIMARY KEY,
        user_id          INTEGER NOT NULL,          -- users.user_id (supervisor / employee)
        emp_id           INTEGER,                   -- employee whose face is being re-captured
        status           VARCHAR(20) NOT NULL DEFAULT 'REQUESTED'
                           CHECK (status IN ('REQUESTED','APPROVED','REJECTED','UPDATED')),
        requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at      TIMESTAMPTZ,
        reviewed_by      INTEGER,                   -- admin users.user_id
        rejection_reason TEXT,
        notes            TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Index for quick admin lookup of pending requests
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_frr_status ON face_recapture_requests(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_frr_user_id ON face_recapture_requests(user_id);
    `);

    // ── admin_notifications ──────────────────────────────────────────────────
    // Generic admin notification feed used for face-request events and other alerts.
    // type values: FACE_REQUEST_RECEIVED | FACE_UPDATED | generic
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id           SERIAL PRIMARY KEY,
        type         VARCHAR(50) NOT NULL DEFAULT 'generic',
        title        TEXT NOT NULL,
        message      TEXT NOT NULL,
        reference_id INTEGER,          -- e.g. face_recapture_requests.id
        is_read      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_notif_read ON admin_notifications(is_read);
    `);

    await client.query("COMMIT");
    console.log("✅  Migration completed successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌  Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
