const assert = require('node:assert/strict');
const pool = require('../config/db');
const { professionalEmployeeWhere } = require('../utils/professionalDesignation');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mapping = await client.query(`SELECT d.designation_id FROM designation d
      JOIN department dep ON dep.department_id = d.department_id
      WHERE d.designation_name = 'Professional' AND dep.department_name = 'Professional'`);
    assert.equal(mapping.rowCount, 1);
    const designationId = mapping.rows[0].designation_id;
    const counts = await client.query(`SELECT COUNT(*)::int AS professionals,
      COUNT(*) FILTER (WHERE e.designation_id <> $1)::int AS incorrect FROM employee e
      WHERE ${professionalEmployeeWhere}`, [designationId]);
    assert.equal(counts.rows[0].incorrect, 0);
    const professional = await client.query('SELECT * FROM employee WHERE self_attendance_enabled = TRUE ORDER BY emp_id LIMIT 1 FOR UPDATE');
    assert.equal(professional.rowCount, 1);
    const otherDesignation = await client.query('SELECT designation_id FROM designation WHERE designation_id <> $1 ORDER BY designation_id LIMIT 1', [designationId]);
    const corrected = await client.query('UPDATE employee SET designation_id = $1 WHERE emp_id = $2 RETURNING *', [otherDesignation.rows[0].designation_id, professional.rows[0].emp_id]);
    assert.deepEqual(corrected.rows[0], professional.rows[0]);
    const ordinary = await client.query(`SELECT e.* FROM employee e WHERE NOT ${professionalEmployeeWhere} ORDER BY emp_id LIMIT 1 FOR UPDATE`);
    assert.equal(ordinary.rowCount, 1);
    const preserved = await client.query('UPDATE employee SET designation_id = $1 WHERE emp_id = $2 RETURNING *', [ordinary.rows[0].designation_id, ordinary.rows[0].emp_id]);
    assert.deepEqual(preserved.rows[0], ordinary.rows[0]);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ ...counts.rows[0], professionalOverrideCorrected: true,
      otherProfessionalFieldsPreserved: true, ordinaryEmployeeUnchanged: true, verificationWritesRolledBack: true }));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
