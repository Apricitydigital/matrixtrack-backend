const pool = require("../config/db");
const {resolveEmployeeAlias,hasRelation}=require('./employeeAliases');

let selfAttendanceEnsured = false;

async function ensureSelfAttendanceSupport() {
  if (selfAttendanceEnsured) {
    return;
  }

  const {rows}=await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
    AND table_name='employee' AND column_name='self_attendance_enabled'`);
  if(!rows.length)throw Object.assign(new Error('Self-attendance schema upgrade is required.'),{status:503});

  selfAttendanceEnsured = true;
}

async function fetchEmployeeById(empId) {
  if (!empId) {
    return null;
  }

  await ensureSelfAttendanceSupport();
  empId=await resolveEmployeeAlias('regular',empId);
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
  const useAliases=await hasRelation('workforce_employee_aliases');
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
      WHERE emp_code = $1 ${useAliases?"OR emp_id::text IN (SELECT target_id FROM workforce_employee_aliases WHERE employee_kind='regular' AND emp_code=$1)":''}
      ORDER BY (emp_code=$1) DESC
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
