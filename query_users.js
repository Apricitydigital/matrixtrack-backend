const { Pool } = require("pg");
require("dotenv").config({ path: "c:/Users/HP/Downloads/Matrix Track Project -april/matrixtrack-backend/.env" });

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  try {
    const res = await pool.query(`
      SELECT user_id, name, phone, role, password 
      FROM users 
      LIMIT 15;
    `);
    console.log("Users available:");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error("Error executing query:", err);
  } finally {
    await pool.end();
  }
}

main();
