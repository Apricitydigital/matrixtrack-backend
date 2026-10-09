const assert = require('node:assert/strict');
const pool = require('../config/db');
const { getApprovedList } = require('../controllers/approvedProfessionalController');
const { getRequests } = require('../controllers/supervisorSelfPunchController');
const makeResponse = () => ({ code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });

async function main() {
  try {
    const nameResponse = makeResponse();
    await getApprovedList({ user: { role: 'admin' }, query: { employee_name: 'Ashu test' } }, nameResponse);
    assert.equal(nameResponse.code, 200);
    assert.ok(nameResponse.body.data.length >= 2);
    const updated = nameResponse.body.data.find(row => row.id === '63285616-8cb6-4b0e-b9b0-d6451270350c');
    assert.equal(updated?.emp_code, 'MP09AP1');
    for (const searchId of [updated.id, String(updated.employee_master_id)]) {
      const download = makeResponse();
      await getApprovedList({ user: { role: 'admin' }, query: { employee_id: searchId } }, download);
      assert.equal(download.code, 200);
      assert.equal(download.body.data.length, 1);
      assert.equal(download.body.data[0].emp_code, 'MP09AP1');
      const list = makeResponse();
      await getRequests({ user: { role: 'admin' }, query: { status: 'approved', employee_id: searchId, limit: 20 } }, list);
      assert.equal(list.code, 200);
      assert.equal(list.body.pagination.total, 1);
      assert.equal(list.body.data[0].id, updated.id);
      assert.equal(list.body.data[0].emp_code, download.body.data[0].emp_code);
    }
    console.log(JSON.stringify({ nameSearchMatches: nameResponse.body.data.length,
      updatedRecord: { id: updated.id, employeeMasterId: updated.employee_master_id, emp_code: updated.emp_code },
      uuidSearchVerified: true, masterIdSearchVerified: true, listAndDownloadMatch: true, databaseWrites: false }));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
