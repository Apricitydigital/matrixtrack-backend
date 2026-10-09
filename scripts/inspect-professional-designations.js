const pool = require('../config/db');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const queries = {
      columns: `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('employee', 'department', 'designation', 'professional_employees')
        ORDER BY table_name, ordinal_position`,
      triggers: `SELECT event_object_table, trigger_name, action_statement FROM information_schema.triggers
        WHERE event_object_table IN ('employee', 'department', 'designation')`,
      professionalLabels: `SELECT d.designation_id, d.designation_name, dp.department_name, COUNT(*)::int AS employees
        FROM employee e LEFT JOIN designation d ON d.designation_id = e.designation_id
        LEFT JOIN department dp ON dp.department_id = d.department_id
        WHERE EXISTS (SELECT 1 FROM professional_employees pe WHERE pe.emp_code = e.emp_code OR pe.mobile = e.phone)
        GROUP BY d.designation_id, d.designation_name, dp.department_name ORDER BY employees DESC`,
      existingProfessionalLabels: `SELECT d.designation_id, d.designation_name, dp.department_id, dp.department_name
        FROM department dp LEFT JOIN designation d ON d.department_id = dp.department_id
        WHERE LOWER(TRIM(dp.department_name)) = 'professional' OR LOWER(TRIM(d.designation_name)) = 'professional'`,
      counts: `SELECT (SELECT COUNT(*) FROM professional_employees)::int AS professional_accounts,
        (SELECT COUNT(*) FROM self_punch_requests WHERE status = 'approved')::int AS approved_requests,
        (SELECT COUNT(*) FROM employee WHERE self_attendance_enabled = TRUE)::int AS self_attendance_employees`,
    };
    for (const [name, sql] of Object.entries(queries)) console.log(JSON.stringify({ name, rows: (await client.query(sql)).rows }));
    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
