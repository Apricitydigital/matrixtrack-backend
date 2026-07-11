const pool = require("../config/db");

async function run() {
  try {
    console.log("Adding columns custom_login_policy and custom_max_devices to users table...");
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_login_policy VARCHAR(50) DEFAULT NULL`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_max_devices INTEGER DEFAULT NULL`);
    console.log("Columns added successfully.");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
