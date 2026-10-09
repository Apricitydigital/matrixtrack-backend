const pool = require('../config/db');
async function main() {
  try {
    const id = 'd4135905-921b-4994-884d-027492e27645';
    const result = await pool.query(`SELECT spr.id, spr.full_name, spr.emp_code AS request_code,
      pe.emp_code AS professional_code, spr.created_at, spr.updated_at, pe.created_at AS account_created_at,
      (SELECT COUNT(*)::int FROM professional_attendance pa WHERE pa.professional_id = pe.id) AS attendance_count,
      (SELECT COUNT(*)::int FROM professional_attendance pa WHERE pa.professional_id = pe.id AND pa.date = CURRENT_DATE) AS today_attendance_count,
      (SELECT json_agg(json_build_object('employee_id', e.emp_id, 'name', e.name, 'code', e.emp_code))
       FROM employee e WHERE e.phone = pe.mobile OR e.emp_code = pe.emp_code OR e.emp_code = spr.emp_code) AS master_matches,
      (SELECT json_agg(l) FROM (SELECT action, note, created_at FROM self_punch_request_logs
        WHERE request_id = spr.id ORDER BY created_at DESC LIMIT 5) l) AS recent_actions
      FROM self_punch_requests spr LEFT JOIN professional_employees pe ON pe.id = spr.id
      WHERE spr.id = $1 OR LOWER(spr.full_name) = 'ashu test'`, [id]);
    console.log(JSON.stringify(result.rows));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
