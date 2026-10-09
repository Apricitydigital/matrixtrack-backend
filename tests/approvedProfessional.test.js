const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const id = '11111111-1111-1111-1111-111111111111';
const timestamp = '2026-10-07T06:00:00.000Z';
const employee = { id, full_name: 'Old Name', mobile: '9876543210', email: 'old@example.com', emp_code: 'EMP1',
  city_id: 1, zone_id: 2, ward_id: 3, kothi_id: 4, updated_at: timestamp, aadhar_number: 'encrypted:123456789012' };

function harness(options = {}) {
  const queries = [];
  const client = {
    release() { queries.push({ sql: 'RELEASE' }); },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT spr.*')) return { rows: options.missing ? [] : [...new Set(params[0])].map(key => ({ ...employee, id: key })), rowCount: options.missing ? 0 : params[0].length };
      if (sql.includes('SELECT 1 FROM zones')) return { rowCount: options.invalidHierarchy ? 0 : 1, rows: [] };
      if (sql.includes('SELECT id FROM professional_employees')) return { rowCount: options.duplicate ? 1 : 0, rows: [] };
      if (sql.includes('SELECT emp_id, designation_id')) return { rowCount: 1, rows: [{ emp_id: 42, designation_id: 2 }] };
      if (sql.includes('SELECT 1 FROM designation')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('SELECT emp_id FROM employee')) return { rowCount: 0, rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [{ email: options.adminEmail || 'mtadmin@apricitydigital.in', role: 'admin' }] }) };
  const module = { exports: {} };
  const dependencies = {
    '../config/db': pool,
    '../utils/encryption': { encryptAadhar: value => `encrypted:${value}`, decryptAadhar: value => value.replace('encrypted:', '') },
    '../controllers/supervisorSelfPunchController': {},
    './supervisorSelfPunchController': { getVisibilityCTE: () => '', visibilityWhereClause: 'TRUE' },
    '../utils/s3SelfPunch': { getSignedS3Url: async value => value },
    '../utils/professionalRequestFilters': require('../utils/professionalRequestFilters'),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/approvedProfessionalController.js'), 'utf8'), {
    module, require: name => dependencies[name], console,
  });
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const run = async (row, preview = true) => {
    await module.exports.updateApprovedList({ body: { rows: Array.isArray(row) ? row : [row], preview }, supervisorId: 1 }, response);
    return response;
  };
  return { ...module.exports, queries, run, response };
}

test('preview compares details with reads only and never locks or writes employee data', async () => {
  const h = harness();
  const res = await h.run({ id, updated_at: timestamp, full_name: 'Correct Name', password_hash: 'overwrite', selfie_url: 'overwrite', is_active: false });
  assert.equal(res.code, 200);
  assert.equal(res.body.changed, 1);
  assert.ok(h.queries.some(q => q.sql === 'ROLLBACK'));
  assert.ok(!h.queries.some(q => q.sql === 'COMMIT'));
  const writes = h.queries.filter(q => q.sql.startsWith('UPDATE'));
  assert.equal(writes.length, 0);
  assert.ok(!h.queries.some(q => /INSERT INTO|FOR UPDATE|pg_advisory_xact_lock/.test(q.sql)));
  assert.ok(h.queries.some(q => q.sql.endsWith('READ ONLY')));
});

test('apply commits profile and Employee Master edits in one transaction', async () => {
  const h = harness();
  const res = await h.run({ id, updated_at: timestamp, mobile: '9123456789', email: 'new@example.com', emp_code: 'EMP2' }, false);
  assert.equal(res.body.changed, 1);
  assert.ok(h.queries.some(q => q.sql === 'COMMIT'));
  assert.ok(h.queries.some(q => q.sql.includes('INSERT INTO self_punch_request_logs')));
  assert.ok(h.queries.some(q => q.sql.startsWith('UPDATE employee SET') && q.params.includes(42)));
  assert.equal(res.body.updated_employees[0].id, id);
  assert.equal(res.body.updated_employees[0].emp_code, 'EMP2');
  assert.ok(!h.queries.some(q => /INSERT INTO (professional_employees|self_punch_requests|employee)\s*\(/.test(q.sql)));
  const profileUpdate = h.queries.find(q => q.sql.startsWith('UPDATE professional_employees'));
  assert.equal(profileUpdate.params[profileUpdate.params.length - 1], id);
});

test('duplicate login identifier rejects and rolls back', async () => {
  const h = harness({ duplicate: true });
  const res = await h.run({ id, updated_at: timestamp, mobile: '9123456789' }, false);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /belongs to another/);
  assert.ok(h.queries.some(q => q.sql === 'ROLLBACK'));
  assert.ok(!h.queries.some(q => q.sql === 'COMMIT'));
});

test('uploaded designation cannot override automatic Professional mapping', async () => {
  const h = harness();
  const res = await h.run({ id, updated_at: timestamp, designation_id: 3 }, false);
  assert.equal(res.body.changed, 0);
  assert.ok(!h.queries.some(q => q.sql.startsWith('UPDATE')));
});

test('stale downloaded rows cannot overwrite newer edits', async () => {
  const h = harness();
  const res = await h.run({ id, updated_at: '2026-10-01T00:00:00Z', full_name: 'Stale' }, false);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /fresh list/);
});

test('invalid geography rejects upload', async () => {
  const h = harness({ invalidHierarchy: true });
  const res = await h.run({ id, updated_at: timestamp, city_id: 99 }, false);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /hierarchy/);
});

test('blank cells and unchanged Aadhaar preserve profile values', async () => {
  const h = harness();
  const res = await h.run({ id, updated_at: timestamp, full_name: '', mobile: '', aadhar_number: '123456789012' });
  assert.equal(res.body.changed, 0);
  assert.ok(!h.queries.some(q => q.sql.startsWith('UPDATE')));
});

test('duplicate permanent IDs roll back earlier writes', async () => {
  const h = harness();
  const row = { id, updated_at: timestamp, full_name: 'Correct Name' };
  const res = await h.run([row, row], false);
  assert.equal(res.code, 400);
  assert.match(res.body.message, /duplicate permanent/);
  assert.ok(h.queries.some(q => q.sql === 'ROLLBACK'));
  assert.ok(!h.queries.some(q => q.sql === 'COMMIT'));
  assert.ok(!h.queries.some(q => q.sql.startsWith('UPDATE')));
});

test('preview returns changed, unchanged and invalid rows together without losing valid differences', async () => {
  const h = harness({ duplicate: true });
  const secondId = '22222222-2222-2222-2222-222222222222';
  const thirdId = '33333333-3333-3333-3333-333333333333';
  const res = await h.run([
    { id, updated_at: timestamp, full_name: 'Correct Name' },
    { id: secondId, updated_at: timestamp, full_name: employee.full_name },
    { id: thirdId, row_number: 25, updated_at: timestamp, mobile: '9123456789' },
  ]);
  assert.equal(res.code, 200);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.changed, 1);
  assert.equal(res.body.unchanged, 1);
  assert.equal(res.body.invalid, 1);
  assert.equal(res.body.changes.length, 2);
  assert.equal(res.body.errors[0].row_number, 25);
  assert.equal(res.body.can_apply, false);
  assert.ok(!h.queries.some(q => /^(UPDATE|INSERT)/.test(q.sql)));
});

test('changed mobile checks only mobile, so an unchanged legacy duplicate employee code does not block preview', async () => {
  const h = harness();
  const res = await h.run({ id, updated_at: timestamp, mobile: '9123456789', emp_code: employee.emp_code });
  assert.equal(res.body.changed, 1);
  const query = h.queries.find(q => q.sql.includes('SELECT id FROM professional_employees'));
  assert.match(query.sql, /mobile = \$2/);
  assert.doesNotMatch(query.sql, /emp_code =|LOWER\(email\)/);
});

test('email casing alone is unchanged and does not invoke duplicate validation', async () => {
  const h = harness({ duplicate: true });
  const res = await h.run({ id, updated_at: timestamp, email: employee.email.toUpperCase() });
  assert.equal(res.body.changed, 0);
  assert.equal(res.body.unchanged, 1);
  assert.ok(!h.queries.some(q => q.sql.includes('SELECT id FROM professional_employees')));
});

test('large unchanged uploads are compared with one employee read and no update queries', async () => {
  const h = harness();
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: `${String(index).padStart(8, '0')}-1111-1111-1111-111111111111`, updated_at: timestamp, full_name: employee.full_name }));
  const res = await h.run(rows);
  assert.equal(res.body.unchanged, 100);
  assert.equal(h.queries.filter(q => q.sql.includes('SELECT spr.*')).length, 1);
  assert.ok(!h.queries.some(q => /FOR UPDATE|^(UPDATE|INSERT)/.test(q.sql)));
});

test('two changed rows cannot claim the same new login identifier before apply writes anything', async () => {
  const rows = [id, '22222222-2222-2222-2222-222222222222'].map(key => ({ id: key, updated_at: timestamp, mobile: '9123456789' }));
  const previewHarness = harness();
  const preview = await previewHarness.run(rows);
  assert.equal(preview.body.changed, 0);
  assert.equal(preview.body.invalid, 2);
  assert.equal(preview.body.can_apply, false);
  const applyHarness = harness();
  const apply = await applyHarness.run(rows, false);
  assert.equal(apply.code, 400);
  assert.ok(!applyHarness.queries.some(q => /^(UPDATE|INSERT)/.test(q.sql)));
});

test('server authorizes exact admin using database identity', async () => {
  const h = harness({ adminEmail: 'other@example.com' });
  let called = false;
  await h.requireListAdmin({ supervisorId: 1, user: { email: 'mtadmin@apricitydigital.in' } }, h.response, () => { called = true; });
  assert.equal(h.response.code, 403);
  assert.equal(called, false);
});

test('existing professional token receives current geography', async () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../middleware/professionalAuth.js'), 'utf8'), {
    module, process: { env: { JWT_SECRET: 'test' } }, require: name => name === 'jsonwebtoken'
      ? { verify: () => ({ professional_id: id, city_id: 1, zone_id: 2, ward_id: 3 }) }
      : { query: async () => ({ rows: [{ city_id: 10, zone_id: 20, ward_id: 30, kothi_id: 40, is_active: true }] }) },
  });
  const req = { header: () => 'Bearer test', cookies: {} };
  let called = false;
  await module.exports(req, {}, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.professional.professional_id, id);
  assert.equal(req.professional.city_id, 10);
  assert.equal(req.professional.ward_id, 30);
});
