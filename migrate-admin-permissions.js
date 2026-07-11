const pool = require("./config/db");

async function run() {
  const client = await pool.connect();
  try {
    console.log("Adding permissions column to users table...");
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT NULL
    `);
    console.log("Migration successful.");
  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    client.release();
    pool.end();
  }
}

run();
