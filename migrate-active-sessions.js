const pool = require("./config/db");

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash VARCHAR(128) NOT NULL,
        ip_address VARCHAR(45),
        device TEXT,
        logged_in_at TIMESTAMP DEFAULT NOW(),
        is_revoked BOOLEAN DEFAULT FALSE,
        revoked_by INTEGER,
        revoked_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_active_sessions_user ON active_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_active_sessions_hash ON active_sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_active_sessions_revoked ON active_sessions(is_revoked);
    `);
    console.log("✅ active_sessions table created successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

migrate();
