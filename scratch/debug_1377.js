const { Pool } = require("pg");
require("dotenv").config({ path: "d:/HumanMatrixSolutions/MatrixTrack/attendease-backend/.env" });

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    console.log("Checking fetchSupervisorFaceEmbeddings for supervisor 1377...");
    const { rows } = await pool.query(
      `
        SELECT DISTINCT e.emp_id, e.emp_code, e.name, e.face_embedding
          FROM employee e
          JOIN supervisor_ward sw ON sw.ward_id = e.ward_id
         WHERE sw.supervisor_id = $1
           AND ($2::int IS NULL OR e.ward_id = $2::int)
           AND e.face_embedding IS NOT NULL
      `,
      [1377, null]
    );
    console.log("Returned rows count:", rows.length);
    console.log("Rows:", rows);
  } catch (err) {
    console.error("Error executing query:", err);
  } finally {
    await pool.end();
  }
})();
