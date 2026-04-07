const pool = require("./config/db");

async function checkSupervisors() {
  try {
    const res = await pool.query(`
      SELECT uca.*, u.name, u.role 
      FROM user_city_access uca 
      JOIN users u ON uca.user_id = u.user_id 
      WHERE u.role = 'supervisor';
    `);
    console.log("Supervisors with City Access:");
    console.table(res.rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkSupervisors();
