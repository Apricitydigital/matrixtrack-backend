const pool = require("../config/db");

async function checkSupervisor() {
  try {
    const res = await pool.query("SELECT user_id, name, profile_photo_url, phone FROM users WHERE user_id = 1394");
    console.log("User Data:", res.rows[0]);
    
    const photoRes = await pool.query("SELECT * FROM supervisor_photos WHERE supervisor_id = 1394");
    console.log("Supervisor Photos Data:", photoRes.rows);
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkSupervisor();
