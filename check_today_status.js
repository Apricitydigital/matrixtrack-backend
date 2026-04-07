const pool = require("./config/db");

async function checkTodayAttendance() {
  const today = new Date().toISOString().split("T")[0];
  console.log("Checking attendance for date:", today);
  
  try {
    const { rows } = await pool.query(
      `SELECT a.attendance_id, a.emp_id, e.name, a.punch_in_time, a.punch_out_time, a.date
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       WHERE a.date = $1`,
      [today]
    );
    
    console.log("Attendance records found:", rows.length);
    rows.forEach(row => {
      console.log(`ID: ${row.attendance_id}, EmpID: ${row.emp_id}, Name: ${row.name}, In: ${row.punch_in_time}, Out: ${row.punch_out_time}`);
    });
    
    // Also check supervisor "demo"
    const supervisorResult = await pool.query(
      `SELECT emp_id, name, face_id FROM employee WHERE name ILIKE '%demo%'`
    );
    console.log("\nSearching for 'demo' in employee table:");
    supervisorResult.rows.forEach(row => {
      console.log(`EmpID: ${row.emp_id}, Name: ${row.name}, FaceID: ${row.face_id}`);
    });

  } catch (err) {
    console.error("Database error:", err);
  } finally {
    await pool.end();
  }
}

checkTodayAttendance();
