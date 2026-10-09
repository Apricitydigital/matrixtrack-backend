const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { findProfessionalIdentityConflict } = require('../utils/professionalIdentity');

test('identity check looks at accounts and pending/approved requests, excluding the same request during approval', async () => {
  let captured;
  const client = { query: async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 'existing', source: 'account' }] }; } };
  const result = await findProfessionalIdentityConflict(client, { mobile: '9876543210', email: ' TEST@EXAMPLE.COM ', empCode: ' NEWCODE ', excludeRequestId: 'own-id' });
  assert.equal(result.source, 'account');
  assert.deepEqual(captured.params, ['9876543210', 'test@example.com', 'NEWCODE', 'own-id']);
  assert.match(captured.sql, /professional_employees/);
  assert.match(captured.sql, /status IN \('pending', 'approved'\)/);
  assert.match(captured.sql, /pe.mobile = \$1/);
  assert.match(captured.sql, /LOWER\(TRIM\(pe.emp_code\)\)/);
  assert.match(captured.sql, /pe.id <> \$4/);
});

test('Aadhaar duplicate check compares decrypted values even with different ciphertexts', async () => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/professionalIdentity.js'), 'utf8'), {
    module, require: () => ({ decryptAadhar: value => ({ 'iv1:cipher1': '123456789012', 'iv2:cipher2': '123456789012' })[value] }),
  });
  const client = { query: async () => ({ rows: [{ aadhar_number: 'iv1:cipher1' }, { aadhar_number: 'iv2:cipher2' }] }) };
  assert.equal(await module.exports.hasAadhaarRequestAtWard(client, '123456789012', 1), true);
  assert.equal(await module.exports.hasAadhaarRequestAtWard(client, '999999999999', 1), false);
});

function loadController(file, client, identityConflict) {
  const module = { exports: {} };
  const multer = () => ({ fields: () => null });
  multer.memoryStorage = () => ({});
  const log = { info() {}, warn() {}, error() {} };
  const dependencies = {
    multer, uuid: { v4: () => { throw new Error('Duplicate must be rejected before UUID generation'); } },
    '../config/db': { connect: async () => client }, '../utils/logger': log,
    '../utils/encryption': { encryptAadhar: () => 'encrypted', decryptAadhar: value => value },
    '../utils/s3SelfPunch': { uploadToS3: () => { throw new Error('Duplicate must be rejected before file upload'); } },
    '../utils/socket': {}, '../utils/cityTrafficCost': {}, './consentController': {},
    '../utils/professionalIdentity': { findProfessionalIdentityConflict: async () => identityConflict },
    '../utils/professionalDesignation': {}, '../utils/professionalRequestFilters': {}, bcryptjs: {}, '../utils/smsNotifier': {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers', file), 'utf8'), { module, require: name => dependencies[name] });
  return module.exports;
}
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });

test('repeat registration with a new code cannot create an account when mobile/email already exists', async () => {
  const queries = [];
  const client = { query: async sql => { queries.push(sql); return { rows: [] }; }, release() {} };
  const controller = loadController('selfPunchController.js', client, { source: 'account', id: 'original-id' });
  const res = response();
  await controller.submitRequest({ body: { full_name: 'Ashu test', emp_code: 'NEWCODE', mobile: '9876543210', email: 'test@example.com', aadhar_number: '123456789012', city_id: 1, zone_id: 1, ward_id: 1 },
    files: { aadhar_doc: [{}], selfie: [{}] } }, res);
  assert.equal(res.code, 409);
  assert.match(res.body.message, /account already exists/);
  assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.some(sql => /INSERT|UPDATE/.test(sql)));
});

test('approving a legacy duplicate stops before changing status, credentials or creating a user', async () => {
  const queries = [];
  const client = { query: async sql => { queries.push(sql); return { rows: [{ id: 'pending-id', status: 'pending', mobile: '9876543210', email: 'test@example.com', emp_code: 'NEWCODE' }] }; }, release() {} };
  const controller = loadController('supervisorSelfPunchController.js', client, { source: 'account', id: 'original-id' });
  const res = response();
  await controller.approveRequest({ user: { role: 'admin' }, supervisorId: 1, params: { id: 'pending-id' }, body: {} }, res);
  assert.equal(res.code, 409);
  assert.match(res.body.message, /create a duplicate/);
  assert.ok(queries.includes('ROLLBACK'));
  assert.ok(!queries.some(sql => /^(INSERT|UPDATE)/.test(sql.trim())));
});
