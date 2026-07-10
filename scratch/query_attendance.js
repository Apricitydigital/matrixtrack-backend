require("dotenv").config();
const { Pool } = require("pg");

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
    const res = await pool.query(
      `SELECT attendance_id, emp_id, date, punch_in_time, punch_out_time, mid_shift_punch_in_time, ward_id 
       FROM attendance 
       ORDER BY attendance_id DESC 
       LIMIT 15`
    );
    console.log("Recent Attendance Records:");
    console.table(res.rows);
  } catch (err) {
    console.error("Database query failed:", err);
  } finally {
    await pool.end();
  }
}

run();
