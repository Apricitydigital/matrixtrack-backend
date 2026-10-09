// Call inside the caller's transaction. A dedicated mapping avoids renaming
// shared designations such as REG PICKER used by ordinary employees.
async function ensureProfessionalDesignation(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('professional-department-designation'))");
  let department = await client.query(`SELECT department_id FROM department
    WHERE LOWER(TRIM(department_name)) = 'professional' ORDER BY department_id LIMIT 1`);
  if (!department.rows.length) {
    department = await client.query("INSERT INTO department (department_name) VALUES ('Professional') RETURNING department_id");
  } else {
    await client.query("UPDATE department SET department_name = 'Professional' WHERE department_id = $1 AND department_name IS DISTINCT FROM 'Professional'", [department.rows[0].department_id]);
  }
  const departmentId = department.rows[0].department_id;
  let designation = await client.query(`SELECT designation_id FROM designation
    WHERE department_id = $1 AND LOWER(TRIM(designation_name)) = 'professional'
    ORDER BY designation_id LIMIT 1`, [departmentId]);
  if (!designation.rows.length) {
    designation = await client.query(`INSERT INTO designation (designation_name, department_id)
      VALUES ('Professional', $1) RETURNING designation_id`, [departmentId]);
  } else {
    await client.query("UPDATE designation SET designation_name = 'Professional' WHERE designation_id = $1 AND designation_name IS DISTINCT FROM 'Professional'", [designation.rows[0].designation_id]);
  }
  return { departmentId, designationId: designation.rows[0].designation_id };
}

// Prefer employee code. When no master record has that code, allow a unique
// phone match for legacy accounts. Never match a second employee by phone.
const professionalEmployeeWhere = `(
  e.self_attendance_enabled = TRUE
  OR EXISTS (SELECT 1 FROM professional_employees pe
    WHERE e.emp_code = COALESCE(NULLIF(TRIM(pe.emp_code), ''),
      'EMP-' || CASE WHEN NULLIF(pe.mobile, '') IS NOT NULL THEN RIGHT(pe.mobile, 6) ELSE LEFT(pe.id::text, 8) END)
    OR (NULLIF(pe.mobile, '') IS NOT NULL AND pe.mobile = e.phone
      AND NOT EXISTS (SELECT 1 FROM employee coded WHERE coded.emp_code = COALESCE(NULLIF(TRIM(pe.emp_code), ''),
        'EMP-' || CASE WHEN NULLIF(pe.mobile, '') IS NOT NULL THEN RIGHT(pe.mobile, 6) ELSE LEFT(pe.id::text, 8) END))
      AND (SELECT COUNT(*) FROM employee other WHERE other.phone = pe.mobile) = 1))
  OR EXISTS (SELECT 1 FROM self_punch_requests spr WHERE spr.status = 'approved'
    AND e.emp_code = COALESCE(NULLIF(TRIM(spr.emp_code), ''),
      'EMP-' || CASE WHEN NULLIF(spr.mobile, '') IS NOT NULL THEN RIGHT(spr.mobile, 6) ELSE LEFT(spr.id::text, 8) END))
)`;

module.exports = { ensureProfessionalDesignation, professionalEmployeeWhere };
