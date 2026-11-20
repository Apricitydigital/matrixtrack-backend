const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { editSelfAttendanceDetails } = require('../utils/selfAttendanceDetailsEdit');

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const updated_at = '2026-11-20T04:30:00.000Z';
const body = { full_name: 'Updated Employee', emp_code: 'NEW-01', updated_at };

test('details controller uses the authenticated actor and city scope, and rolls back failed audit writes', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const commands = [];
  let rejected = true;
  const client = { query: async sql => { commands.push(sql); return { rows: [] }; }, release: () => commands.push('RELEASE') };
  const module = { exports: {} };
  const deps = {
    '../config/db': { connect: async () => client },
    '../middleware/permissionMiddleware': { getPermissionCityFilter: () => [1] },
    '../utils/selfAttendanceDetailsEdit': { editSelfAttendanceDetails: async (connection, requestId, input, actor, scope) => {
      assert.equal(connection, client); assert.equal(requestId, id); assert.equal(actor, 9);
      assert.deepEqual(scope, [1]);
      if (rejected) throw new Error('Audit unavailable');
      return { changed: true };
    } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/selfAttendanceDetailsController.js'), 'utf8'), {
    module, require: key => deps[key],
  });
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(value) { this.data = value; } });
  const req = { params: { id }, body: { ...body, performed_by_id: 999 }, supervisorId: 9 };
  const failed = response();
  await module.exports.editRequestDetails(req, failed);
  assert.equal(failed.code, 500); assert.ok(commands.includes('ROLLBACK')); assert.ok(!commands.includes('COMMIT'));
  assert.equal(commands.at(-1), 'RELEASE');
  rejected = false; commands.length = 0;
  const saved = response(); await module.exports.editRequestDetails(req, saved);
  assert.equal(saved.code, 200); assert.ok(commands.includes('COMMIT')); assert.ok(!commands.includes('ROLLBACK'));
  assert.equal(commands.at(-1), 'RELEASE');
});

test('request details edits preserve identity and history and record attributable before/after values', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE self_punch_requests(id UUID PRIMARY KEY,status TEXT,emp_code TEXT,mobile TEXT,
      city_id INT,zone_id INT,kothi_id INT,full_name TEXT,updated_at TIMESTAMPTZ,aadhar_number TEXT,aadhar_doc_url TEXT,selfie_url TEXT);
    INSERT INTO self_punch_requests VALUES('${id}','approved','OLD-01','test-phone',1,10,1000,'Original Employee','${updated_at}',NULL,'document','selfie'),
      ('${other}','approved','TAKEN','other-phone',2,20,2000,'Other Employee','${updated_at}',NULL,NULL,NULL);
    CREATE TABLE self_attendance_employees AS SELECT *,TRUE AS is_active,'password-hash'::text AS password_hash FROM self_punch_requests;
    CREATE TABLE employee(emp_id SERIAL PRIMARY KEY,emp_code TEXT UNIQUE,phone TEXT,ward_id INT,name TEXT,
      designation_id INT,aadhar_no TEXT,aadhar_url TEXT,face_embedding TEXT,self_attendance_enabled BOOLEAN);
    INSERT INTO employee VALUES(7,'OLD-01','test-phone',1000,'Original Employee',74,NULL,'document','original-face',TRUE),
      (8,'TAKEN','other-phone',2000,'Other Employee',74,NULL,NULL,'other-face',TRUE);
    CREATE TABLE self_punch_request_logs(id SERIAL,request_id UUID,action TEXT,performed_by_type TEXT,performed_by_id INT,note TEXT,created_at TIMESTAMPTZ DEFAULT clock_timestamp());
    CREATE TABLE cities(city_id INT PRIMARY KEY); INSERT INTO cities VALUES(1),(2);
    CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT); INSERT INTO zones VALUES(10,1),(20,2);
    CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT); INSERT INTO wards VALUES(1000,10),(2000,20);
    CREATE TABLE department(department_id SERIAL,department_name TEXT); INSERT INTO department VALUES(1,'Self Attendance');
    CREATE TABLE designation(designation_id SERIAL,designation_name TEXT,department_id INT); INSERT INTO designation VALUES(74,'Self Attendance',1);
    CREATE TABLE self_attendance_records(id INT,self_attendance_id UUID,punch_in TEXT);
    INSERT INTO self_attendance_records VALUES(1,'${id}','original-punch');
  `);
  const snapshot = async () => {
    const result = {};
    for (const table of ['self_punch_requests','self_attendance_employees','employee','self_punch_request_logs','self_attendance_records']) {
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY ${table === 'employee' ? 'emp_id' : 'id'}`)).rows;
    }
    return result;
  };
  const baseline = await snapshot();
  const sandbox = async action => {
    await db.query('BEGIN');
    try { await action(); } finally { await db.query('ROLLBACK'); }
    assert.deepEqual(await snapshot(), baseline);
  };

  await t.test('name and code sync to the exact account, request and Master with audit', () => sandbox(async () => {
    const result = await editSelfAttendanceDetails(db, id, body, 9, [1]);
    assert.equal(result.changed, true);
    const after = await snapshot();
    assert.equal(after.employee[0].name, body.full_name);
    assert.equal(after.employee[0].emp_code, body.emp_code);
    assert.deepEqual(after.employee[1], baseline.employee[1]);
    assert.deepEqual(after.self_attendance_records, baseline.self_attendance_records);
    for (const table of ['self_punch_requests','self_attendance_employees']) {
      const row = after[table].find(person => person.id === id);
      assert.equal(row.full_name, body.full_name); assert.equal(row.emp_code, body.emp_code);
      assert.equal(row.id, id); assert.equal(row.mobile, 'test-phone');
    }
    assert.equal(after.self_attendance_employees.find(row => row.id === id).password_hash, 'password-hash');
    const log = after.self_punch_request_logs[0];
    assert.equal(log.performed_by_id, 9); assert.equal(log.performed_by_type, 'admin');
    assert.ok(log.created_at);
    assert.deepEqual(JSON.parse(log.note.split('Employee details updated: ')[1]), {
      full_name: { before: 'Original Employee', after: body.full_name }, emp_code: { before: 'OLD-01', after: body.emp_code },
    });
  }));
  for (const [label, changes, scope, status] of [
    ['stale edit', { updated_at: '2026-11-19' }, null, 409],
    ['out of scope', {}, [2], 403], ['empty name', { full_name: ' ' }, null, 400],
    ['empty code', { emp_code: '' }, null, 400], ['duplicate code', { emp_code: ' taken ' }, null, 409],
  ]) await t.test(label, () => sandbox(async () => {
    await assert.rejects(editSelfAttendanceDetails(db, id, { ...body, ...changes }, 9, scope), { status });
  }));
  await t.test('unchanged details produce no audit writes', () => sandbox(async () => {
    assert.equal((await editSelfAttendanceDetails(db, id, { ...body, full_name: 'Original Employee', emp_code: 'OLD-01' }, 9)).changed, false);
    assert.deepEqual(await snapshot(), baseline);
  }));
  await t.test('shared old code never renames another Master person; unique replacement repairs missing Master', () => sandbox(async () => {
    await db.exec("UPDATE employee SET name='Unrelated legacy owner',phone='other-phone',ward_id=2000 WHERE emp_id=7");
    await assert.rejects(editSelfAttendanceDetails(db, id, { ...body, emp_code: 'OLD-01' }, 9), /another person/);
    await editSelfAttendanceDetails(db, id, body, 9);
    const masters = (await db.query('SELECT * FROM employee ORDER BY emp_id')).rows;
    assert.equal(masters.find(row => row.emp_id === 7).name, 'Unrelated legacy owner');
    const repaired = masters.find(row => row.emp_code === body.emp_code);
    assert.equal(repaired.name, body.full_name); assert.equal(repaired.ward_id, 1000);
    assert.equal(repaired.self_attendance_enabled, true);
  }));
  await t.test('pending edit changes request only and is audited', () => sandbox(async () => {
    await db.query("UPDATE self_punch_requests SET status='pending' WHERE id=$1", [id]);
    await db.query('DELETE FROM self_attendance_employees WHERE id=$1', [id]);
    await editSelfAttendanceDetails(db, id, body, 9);
    assert.deepEqual((await snapshot()).employee, baseline.employee);
    assert.equal((await db.query('SELECT full_name FROM self_punch_requests WHERE id=$1', [id])).rows[0].full_name, body.full_name);
  }));
  await t.test('failed audit rolls back all three name/code updates', async () => {
    await db.query('BEGIN');
    const client = { query: (sql, params) => sql.includes('INSERT INTO self_punch_request_logs')
      ? Promise.reject(new Error('Audit unavailable')) : db.query(sql, params) };
    await assert.rejects(editSelfAttendanceDetails(client, id, body, 9), /Audit unavailable/);
    await db.query('ROLLBACK');
    assert.deepEqual(await snapshot(), baseline);
  });
});
