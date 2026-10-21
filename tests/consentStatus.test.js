const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function controller(query) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/consentController.js'), 'utf8'), {
    module, require: name => name === '../config/db' ? { query } : { error() {}, info() {} },
  });
  return module.exports.getConsentStatusApi;
}
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('professional status uses token identity and latest versioned self consent', async () => {
  const handler = controller(async (sql, args) => {
    assert.equal(args[0], 17);
    assert.equal(args[1], 'SELF');
    assert.equal(args[3], 'v1.0');
    assert.match(sql, /user_id = \$1/);
    assert.match(sql, /ORDER BY created_at DESC, id DESC LIMIT 1/);
    return { rows: [{ consent_given: true }] };
  });
  const res = response();
  await handler({ professional: { professional_id: 17 }, query: { userId: 99 } }, res);
  assert.equal(res.body.consentGiven, true);
});

test('supervisor status cannot reuse another actor type or worker account identity', async () => {
  const handler = controller(async (sql, args) => {
    assert.match(sql, /supervisor_id = \$1/);
    assert.equal(args[0], 8);
    assert.equal(args[1], 'SUPERVISOR_PROXY');
    return { rows: [] };
  });
  const res = response();
  await handler({ user: { user_id: 8 } }, res);
  assert.equal(res.body.consentGiven, false);
});

test('latest negative consent is not treated as granted', async () => {
  const handler = controller(async () => ({ rows: [{ consent_given: false }] }));
  const res = response();
  await handler({ professional: { professional_id: 17 } }, res);
  assert.equal(res.body.consentGiven, false);
});

test('database failure returns failure instead of an unrecorded-consent result', async () => {
  const handler = controller(async () => { throw Error('Database unavailable'); });
  const res = response();
  await handler({ professional: { professional_id: 17 } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
});
