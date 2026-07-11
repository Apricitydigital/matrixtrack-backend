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
    const profEmpCols = await pool.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'professional_employees'`
    );
    console.log("professional_employees Columns:");
    console.table(profEmpCols.rows);

    const profAttCols = await pool.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'professional_attendance'`
    );
    console.log("professional_attendance Columns:");
    console.table(profAttCols.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
