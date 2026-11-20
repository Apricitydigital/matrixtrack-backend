const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

async function harness(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE employee (emp_id INT PRIMARY KEY, name TEXT NOT NULL, emp_code TEXT UNIQUE,
      phone TEXT, ward_id INT, designation_id INT, aadhar_no TEXT, aadhar_url TEXT,
      face_embedding TEXT, no_personal_phone BOOLEAN DEFAULT FALSE, self_attendance_enabled BOOLEAN);
    CREATE TABLE self_attendance_employees (id TEXT PRIMARY KEY, request_id TEXT, full_name TEXT,
      emp_code TEXT, mobile TEXT, kothi_id INT, is_active BOOLEAN);
    CREATE TABLE self_punch_requests (id TEXT PRIMARY KEY, full_name TEXT, updated_at TIMESTAMPTZ);
    CREATE TABLE wards (ward_id INT PRIMARY KEY, zone_id INT, ward_name TEXT);
    CREATE TABLE zones (zone_id INT PRIMARY KEY, city_id INT, zone_name TEXT);
    CREATE TABLE cities (city_id INT PRIMARY KEY, city_name TEXT);
    CREATE TABLE designation (designation_id INT PRIMARY KEY, department_id INT, designation_name TEXT);
    CREATE TABLE department (department_id INT PRIMARY KEY, department_name TEXT);
    INSERT INTO employee VALUES (30490,'Ashutosh Parakh','MP08003','test-phone',1008,74,NULL,NULL,NULL,FALSE,TRUE);
    INSERT INTO self_attendance_employees VALUES
      ('active','active','Ashutosh Parakh','MP08003','test-phone',1008,TRUE),
      ('inactive','inactive','Ashutosh Parakh','MP08003','test-phone',1008,FALSE),
      ('other','other','Other Employee','MP08003','other-phone',1611,TRUE);
    INSERT INTO self_punch_requests (id,full_name) SELECT id,full_name FROM self_attendance_employees;
  `);
  let released = false;
  const client = { query: async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  }, release() { released = true; } };
  const handlers = {};
  const router = { get() {}, post() {}, delete() {}, put(route, handler) { handlers[route] = handler; } };
  const noop = () => {};
  const dependencies = {
    express: { Router: () => router }, '../config/db': { connect: async () => client },
    multer: () => ({ single: () => noop }), 'multer-s3': () => ({}),
    '../config/awsConfig': {}, '../utils/faceImage': { buildPublicFaceUrl: () => null },
    '../utils/backblaze': { isBackblazeUrl: () => false }, '../middleware/authMiddleware': noop,
    '../middleware/cityScope': { requireCityScope: () => noop }, '../middleware/kothiScope': {},
    '../middleware/permissionMiddleware': { authorize: () => noop }, '../controllers/employeeBulkImportController': {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/employeeRoutes.js'), 'utf8'), {
    require: key => Object.hasOwn(dependencies, key) ? dependencies[key] : require(key),
    module: { exports: {} }, process: { env: {} }, console: { error() {} },
  });
  return { db, async rename(overrides = {}) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handlers['/:id']({ params: { id: 30490 }, body: {
      name: 'Ashutosh Parakh Test', emp_code: 'MP08003', phone: 'test-phone', ward_id: 1008, designation_id: 74, ...overrides,
    } }, res);
    assert.equal(released, true);
    return res;
  } };
}

test('Ashutosh Parakh Master rename reaches the active app profile and request only', async t => {
  const h = await harness(t);
  const result = await h.rename();
  assert.equal(result.code, 200);
  assert.equal(result.body.name, 'Ashutosh Parakh Test');
  const names = (await h.db.query('SELECT id, full_name FROM self_attendance_employees ORDER BY id')).rows;
  assert.deepEqual(names, [
    { id: 'active', full_name: 'Ashutosh Parakh Test' },
    { id: 'inactive', full_name: 'Ashutosh Parakh' },
    { id: 'other', full_name: 'Other Employee' },
  ]);
  assert.deepEqual((await h.db.query('SELECT id,full_name FROM self_punch_requests ORDER BY id')).rows, names);
});

test('shared code with a different site cannot rename another app user', async t => {
  const h = await harness(t);
  await h.db.exec("UPDATE self_attendance_employees SET kothi_id=1611 WHERE id='active'");
  assert.equal((await h.rename()).code, 409);
  assert.equal((await h.db.query('SELECT name FROM employee')).rows[0].name, 'Ashutosh Parakh');
  assert.equal((await h.db.query("SELECT full_name FROM self_attendance_employees WHERE id='active'")).rows[0].full_name, 'Ashutosh Parakh');
});

test('duplicate active identities reject the edit without changing Master', async t => {
  const h = await harness(t);
  await h.db.exec("UPDATE self_attendance_employees SET is_active=TRUE WHERE id='inactive'");
  assert.equal((await h.rename()).code, 409);
  assert.equal((await h.db.query('SELECT name FROM employee')).rows[0].name, 'Ashutosh Parakh');
});

test('a failed Master update rolls back the profile and registration rename', async t => {
  const h = await harness(t);
  await h.db.exec("INSERT INTO employee(emp_id,name,emp_code) VALUES(2,'Unrelated','TAKEN')");
  assert.equal((await h.rename({ emp_code: 'TAKEN' })).code, 409);
  assert.equal((await h.db.query('SELECT name FROM employee WHERE emp_id=30490')).rows[0].name, 'Ashutosh Parakh');
  assert.equal((await h.db.query("SELECT full_name FROM self_attendance_employees WHERE id='active'")).rows[0].full_name, 'Ashutosh Parakh');
  assert.equal((await h.db.query("SELECT full_name FROM self_punch_requests WHERE id='active'")).rows[0].full_name, 'Ashutosh Parakh');
});

test('regular employee names still save without a self-attendance profile', async t => {
  const h = await harness(t);
  await h.db.exec("DELETE FROM self_attendance_employees; UPDATE employee SET self_attendance_enabled=FALSE");
  assert.equal((await h.rename()).code, 200);
});
