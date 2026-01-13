const pool = require("../config/db");

let selfAttendanceEnsured = false;

async function ensureSelfAttendanceSupport() {
  if (selfAttendanceEnsured) {
    return;
  }

  await pool.query(
    `ALTER TABLE IF EXISTS employee
       ADD COLUMN IF NOT EXISTS self_attendance_enabled BOOLEAN DEFAULT FALSE`
  );

  selfAttendanceEnsured = true;
}

async function fetchEmployeeById(empId) {
  if (!empId) {
    return null;
  }

  await ensureSelfAttendanceSupport();
  const { rows } = await pool.query(
    `SELECT emp_id,
            emp_code,
            name,
            phone,
            ward_id,
            face_embedding,
            face_id,
            face_confidence,
            self_attendance_enabled
       FROM employee
      WHERE emp_id = $1
      LIMIT 1`,
    [empId]
  );

  return rows[0] || null;
}

async function fetchEmployeeByCode(empCode) {
  if (!empCode) {
    return null;
  }

  await ensureSelfAttendanceSupport();
  const { rows } = await pool.query(
    `SELECT emp_id,
            emp_code,
            name,
            phone,
            ward_id,
            face_embedding,
            face_id,
            face_confidence,
            self_attendance_enabled
       FROM employee
      WHERE emp_code = $1
      LIMIT 1`,
    [empCode]
  );

  return rows[0] || null;
}

module.exports = {
  ensureSelfAttendanceSupport,
  fetchEmployeeById,
  fetchEmployeeByCode,
};
