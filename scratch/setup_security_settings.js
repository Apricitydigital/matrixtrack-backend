const { Pool } = require("pg");
require("dotenv").config();

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
    console.log("Setting up security_settings table...");
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_settings (
        id INT PRIMARY KEY,
        admin_login_mode VARCHAR(20) DEFAULT 'multiple',
        admin_max_devices INT DEFAULT 10,
        supervisor_login_mode VARCHAR(20) DEFAULT 'multiple',
        supervisor_max_devices INT DEFAULT 10,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert default row if not exists
    await pool.query(`
      INSERT INTO security_settings (id, admin_login_mode, admin_max_devices, supervisor_login_mode, supervisor_max_devices)
      VALUES (1, 'multiple', 10, 'multiple', 10)
      ON CONFLICT (id) DO NOTHING
    `);

    console.log("Adding last_active_at to active_sessions...");
    await pool.query(`
      ALTER TABLE active_sessions 
      ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);

    console.log("Database setup complete.");
  } catch (err) {
    console.error("Error setting up database:", err);
  } finally {
    await pool.end();
  }
}

run();
