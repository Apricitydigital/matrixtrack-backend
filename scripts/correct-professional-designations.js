const fs = require('node:fs');
const path = require('node:path');
const pool = require('../config/db');
const { ensureProfessionalDesignation, professionalEmployeeWhere } = require('../utils/professionalDesignation');

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { departmentId, designationId } = await ensureProfessionalDesignation(client);
    await client.query(`CREATE TEMP TABLE professional_designation_before ON COMMIT DROP AS
      SELECT e.emp_id, e.designation_id, to_jsonb(e) - 'designation_id' AS preserved
      FROM employee e WHERE ${professionalEmployeeWhere}`);
    const before = await client.query('SELECT emp_id, designation_id FROM professional_designation_before ORDER BY emp_id');
    const changed = await client.query(`UPDATE employee e SET designation_id = $1
      FROM professional_designation_before b WHERE b.emp_id = e.emp_id
      AND e.designation_id IS DISTINCT FROM $1 RETURNING e.emp_id`, [designationId]);
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '20261007_professional_designation_guard.sql'), 'utf8'));
    const violations = await client.query(`SELECT COUNT(*)::int AS count FROM professional_designation_before b
      LEFT JOIN employee e ON e.emp_id = b.emp_id
      WHERE e.emp_id IS NULL OR (to_jsonb(e) - 'designation_id') IS DISTINCT FROM b.preserved
        OR e.designation_id IS DISTINCT FROM $1`, [designationId]);
    if (violations.rows[0].count) throw new Error('Employee preservation check failed; rolling back.');
    // No writes to professional accounts, credentials, sessions or attendance.
    let backupPath;
    if (apply) {
      const directory = path.join(__dirname, '..', 'scratch');
      fs.mkdirSync(directory, { recursive: true });
      backupPath = path.join(directory, `professional-designations-${Date.now()}.json`);
      fs.writeFileSync(backupPath, JSON.stringify({ departmentId, designationId, previousEmployeeDesignations: before.rows }, null, 2), { flag: 'wx' });
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run-rolled-back', department: 'Professional', designation: 'Professional',
      departmentId, designationId, matchedEmployees: before.rowCount, changedEmployees: changed.rowCount,
      preservedEmployeeFields: true, automaticDesignationGuard: true, backupPath }));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
