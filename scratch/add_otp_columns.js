const { Pool } = require("pg");
require("dotenv").config(); // Reads from cwd

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  try {
    console.log("Adding columns login_otp and login_otp_expiry to users table...");
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_otp VARCHAR(10)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_otp_expiry TIMESTAMP`);
    console.log("Columns added successfully.");
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
