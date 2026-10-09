const assert = require('node:assert/strict');
const pool = require('../config/db');
const { updateApprovedList } = require('../controllers/approvedProfessionalController');

async function main() {
  try {
    const { rows } = await pool.query(`SELECT spr.id, spr.updated_at, spr.full_name
      FROM self_punch_requests spr JOIN professional_employees pe ON pe.id = spr.id
      WHERE spr.status = 'approved' ORDER BY spr.created_at DESC LIMIT 50`);
    assert.ok(rows.length > 1);
    const upload = rows.map(row => ({ ...row }));
    upload[0].full_name = `${upload[0].full_name.slice(0, 170)} (preview verification)`;
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await updateApprovedList({ body: { rows: upload, preview: true }, supervisorId: null }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.changed, 1);
    assert.equal(res.body.unchanged, rows.length - 1);
    assert.equal(res.body.invalid, 0);
    const after = await pool.query('SELECT full_name, updated_at FROM self_punch_requests WHERE id = $1', [rows[0].id]);
    assert.equal(after.rows[0].full_name, rows[0].full_name);
    assert.equal(new Date(after.rows[0].updated_at).getTime(), new Date(rows[0].updated_at).getTime());
    console.log(JSON.stringify({ previewOnly: true, changed: res.body.changed, unchanged: res.body.unchanged,
      invalid: res.body.invalid, employeeDetailsUnchanged: true }));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
