const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureSelfAttendanceDesignation, selfAttendanceEmployeeWhere } = require('../utils/selfAttendanceDesignation');

test('creates dedicated SelfAttendance department and designation without changing shared labels', async () => {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO department')) return { rows: [{ department_id: 50 }] };
    if (sql.includes('INSERT INTO designation')) return { rows: [{ designation_id: 70 }] };
    return { rows: [] };
  } };
  assert.deepEqual(await ensureSelfAttendanceDesignation(client), { departmentId: 50, designationId: 70 });
  const insert = queries.find(q => q.sql.includes('INSERT INTO designation'));
  assert.deepEqual(insert.params, [50]);
  assert.ok(!queries.some(q => q.sql.startsWith('UPDATE')));
  assert.ok(!queries.some(q => /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:employee|attendance|self_attendance_records|active_sessions|users)\b/i.test(q.sql)));
});

test('reuses existing SelfAttendance mapping without duplicate inserts', async () => {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT department_id')) return { rows: [{ department_id: 50 }] };
    if (sql.startsWith('SELECT designation_id')) return { rows: [{ designation_id: 70 }] };
    return { rows: [] };
  } };
  assert.deepEqual(await ensureSelfAttendanceDesignation(client), { departmentId: 50, designationId: 70 });
  assert.ok(!queries.some(q => q.sql.startsWith('INSERT')));
  const updates = queries.filter(q => q.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 2);
  assert.ok(updates.every(q => /WHERE (department_id|designation_id) = \$1/.test(q.sql)));
});

test('approval upsert applies the dedicated mapping to new and existing master rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '../controllers/supervisorSelfPunchController.js'), 'utf8');
  assert.match(source, /ensureSelfAttendanceDesignation\(client\)/);
  assert.match(source, /ON CONFLICT \(emp_code\) DO UPDATE SET\s+designation_id = EXCLUDED.designation_id/);
  assert.doesNotMatch(source, /SELECT designation_id FROM designation ORDER BY designation_id ASC LIMIT 1/);
  assert.match(source, /throw empSyncErr/);
});

test('backfill is scoped to self_attendance identity and guards ambiguous phone matches', () => {
  assert.match(selfAttendanceEmployeeWhere, /self_attendance_enabled = TRUE/);
  assert.match(selfAttendanceEmployeeWhere, /self_attendance_employees/);
  assert.match(selfAttendanceEmployeeWhere, /spr.status = 'approved'/);
  assert.match(selfAttendanceEmployeeWhere, /NOT EXISTS/);
  assert.match(selfAttendanceEmployeeWhere, /COUNT\(\*\).*other.phone = pe.mobile\) = 1/);
});

test('database guard corrects legacy approvals and writes only designation_id', () => {
  const source = fs.readFileSync(path.join(__dirname, '../db/migrations/20261007_self_attendance_designation_guard.sql'), 'utf8');
  assert.match(source, /BEFORE INSERT OR UPDATE OF designation_id, self_attendance_enabled ON employee/);
  assert.match(source, /NEW.self_attendance_enabled IS TRUE/);
  const assignments = [...source.matchAll(/NEW\.(\w+)\s*:=/g)].map(match => match[1]);
  assert.deepEqual(assignments, ['designation_id']);
  assert.doesNotMatch(source, /\b(UPDATE|DELETE FROM|INSERT INTO)\s+(self_attendance_records|self_attendance_employees|active_sessions|users)\b/i);
});
