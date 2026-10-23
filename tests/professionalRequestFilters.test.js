const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProfessionalRequestFilters, buildScopedProfessionalRequestFilters } = require('../utils/professionalRequestFilters');

test('combines hierarchy and case-insensitive name search after existing scope parameters', () => {
  const params = [55, 'approved'];
  const sql = buildProfessionalRequestFilters({ city_id: 1, employee_name: ' Ashu test ' }, params);
  assert.deepEqual(params, [55, 'approved', '1', '%Ashu test%']);
  assert.match(sql, /spr.city_id::text = \$3/);
  assert.match(sql, /spr.full_name ILIKE \$4/);
});

test('permanent UUID identifies one profile independently of duplicate employee names', () => {
  const params = [];
  const sql = buildProfessionalRequestFilters({ employee_id: '63285616-8cb6-4b0e-b9b0-d6451270350c' }, params);
  assert.equal(params[0], '%63285616-8cb6-4b0e-b9b0-d6451270350c%');
  assert.match(sql, /spr.id::text ILIKE \$1/);
});

test('numeric employee ID searches Employee Master instead of matching digits inside every UUID', () => {
  const params = [];
  const sql = buildProfessionalRequestFilters({ employee_id: '30624' }, params);
  assert.deepEqual(params, ['30624']);
  assert.match(sql, /em.emp_id::text = \$1/);
  assert.doesNotMatch(sql, /spr.id::text ILIKE/);
});

test('name wildcards and SQL-looking input are treated as literal parameter values', () => {
  const params = [];
  const sql = buildProfessionalRequestFilters({ employee_name: "Ashu_%' OR TRUE --" }, params);
  assert.equal(params[0], "%Ashu\\_\\%' OR TRUE --%");
  assert.doesNotMatch(sql, /OR TRUE/);
});

test('mobile search normalizes country codes and formatted numbers', () => {
  const params = [];
  const sql = buildProfessionalRequestFilters({ mobile: '+91 98765-43210' }, params);
  assert.deepEqual(params, ['%9876543210%']);
  assert.match(sql, /REGEXP_REPLACE/);
  assert.match(sql, /LIKE \$1/);
  assert.match(buildProfessionalRequestFilters({ mobile: 'abc' }, []), /AND FALSE/);
});

test('Aadhaar search matches randomized ciphertext and plaintext within the supplied scope', async () => {
  process.env.AADHAR_ENCRYPTION_KEY ||= '12345678901234567890123456789012';
  // Load encryption after setting the fixture key.
  delete require.cache[require.resolve('../utils/encryption')];
  delete require.cache[require.resolve('../utils/professionalIdentity')];
  const { encryptAadhar } = require('../utils/encryption');
  const first = encryptAadhar('123456789012');
  const second = encryptAadhar('123456789012');
  assert.notEqual(first, second);
  const params = [55, 'approved'];
  let calls = 0;
  const client = { query: async (sql, values) => {
    if (sql.includes('to_regclass')) return {rows:[{available:true}]};
    calls++;
    assert.match(sql, /WITH allowed AS/);
    assert.match(sql, /spr.ward_id IN \(SELECT ward_id FROM allowed\) AND spr.status = \$2/);
    assert.match(sql, /spr.city_id::text = \$3/);
    assert.deepEqual(values, [55, 'approved', '1']);
    return { rows: [
      { id: 'one', aadhar_number: first }, { id: 'two', aadhar_number: second },
      { id: 'legacy', aadhar_number: '123456789012' },
      { id: 'other', aadhar_number: encryptAadhar('999999999999') },
      { id: 'broken', aadhar_number: 'invalid' },
    ] };
  } };
  const sql = await buildScopedProfessionalRequestFilters({ city_id: '1', aadhar_number: '1234 5678 9012' }, params, {
    client, visibilitySql: 'WITH allowed AS (SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1)',
    where: 'spr.ward_id IN (SELECT ward_id FROM allowed) AND spr.status = $2',
  });
  assert.equal(calls, 1);
  assert.deepEqual(params, [55, 'approved', '1', ['one', 'two', 'legacy']]);
  assert.match(sql, /spr.id = ANY\(\$4::uuid\[\]\)/);
  assert.ok(!sql.includes('123456789012'));
});

test('incomplete Aadhaar avoids scanning and a complete unmatched Aadhaar produces no IDs', async () => {
  const client = { query: async () => ({ rows: [] }) };
  const partial = await buildScopedProfessionalRequestFilters({ aadhar_number: '1234' }, [], {
    client: { query: () => assert.fail('Incomplete Aadhaar must not query records') },
  });
  assert.match(partial, /AND FALSE/);
  const params = [];
  const missing = await buildScopedProfessionalRequestFilters({ aadhar_number: '123456789012' }, params, { client });
  assert.deepEqual(params, [[]]);
  assert.match(missing, /ANY/);
});
