const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProfessionalRequestFilters } = require('../utils/professionalRequestFilters');

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
