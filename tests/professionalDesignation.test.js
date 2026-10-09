const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureProfessionalDesignation, professionalEmployeeWhere } = require('../utils/professionalDesignation');

test('creates dedicated Professional department and designation without changing shared labels', async () => {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO department')) return { rows: [{ department_id: 50 }] };
    if (sql.includes('INSERT INTO designation')) return { rows: [{ designation_id: 70 }] };
    return { rows: [] };
  } };
  assert.deepEqual(await ensureProfessionalDesignation(client), { departmentId: 50, designationId: 70 });
  const insert = queries.find(q => q.sql.includes('INSERT INTO designation'));
  assert.deepEqual(insert.params, [50]);
  assert.ok(!queries.some(q => q.sql.startsWith('UPDATE')));
  assert.ok(!queries.some(q => /employee|attendance|session|password/.test(q.sql)));
});

test('reuses existing Professional mapping without duplicate inserts', async () => {
  const queries = [];
  const client = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT department_id')) return { rows: [{ department_id: 50 }] };
    if (sql.startsWith('SELECT designation_id')) return { rows: [{ designation_id: 70 }] };
    return { rows: [] };
  } };
  assert.deepEqual(await ensureProfessionalDesignation(client), { departmentId: 50, designationId: 70 });
  assert.ok(!queries.some(q => q.sql.startsWith('INSERT')));
  const updates = queries.filter(q => q.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 2);
  assert.ok(updates.every(q => /WHERE (department_id|designation_id) = \$1/.test(q.sql)));
});

test('approval upsert applies the dedicated mapping to new and existing master rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '../controllers/supervisorSelfPunchController.js'), 'utf8');
  assert.match(source, /ensureProfessionalDesignation\(client\)/);
  assert.match(source, /ON CONFLICT \(emp_code\) DO UPDATE SET\s+designation_id = EXCLUDED.designation_id/);
  assert.doesNotMatch(source, /SELECT designation_id FROM designation ORDER BY designation_id ASC LIMIT 1/);
  assert.match(source, /throw empSyncErr/);
});

test('backfill is scoped to professional identity and guards ambiguous phone matches', () => {
  assert.match(professionalEmployeeWhere, /self_attendance_enabled = TRUE/);
  assert.match(professionalEmployeeWhere, /professional_employees/);
  assert.match(professionalEmployeeWhere, /spr.status = 'approved'/);
  assert.match(professionalEmployeeWhere, /NOT EXISTS/);
  assert.match(professionalEmployeeWhere, /COUNT\(\*\).*other.phone = pe.mobile\) = 1/);
});

test('database guard corrects legacy approvals and writes only designation_id', () => {
  const source = fs.readFileSync(path.join(__dirname, '../db/migrations/20261007_professional_designation_guard.sql'), 'utf8');
  assert.match(source, /BEFORE INSERT OR UPDATE OF designation_id, self_attendance_enabled ON employee/);
  assert.match(source, /NEW.self_attendance_enabled IS TRUE/);
  const assignments = [...source.matchAll(/NEW\.(\w+)\s*:=/g)].map(match => match[1]);
  assert.deepEqual(assignments, ['designation_id']);
  assert.doesNotMatch(source, /\b(UPDATE|DELETE FROM|INSERT INTO)\s+(professional_attendance|professional_employees|active_sessions|users)\b/i);
});
