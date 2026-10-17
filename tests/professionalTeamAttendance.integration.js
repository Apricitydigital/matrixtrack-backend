// Isolated PostgreSQL tests; no live database connections.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');

async function main() {
  const db = new PGlite();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const client = { query: (sql, values) => db.query(sql, values) };
  const load = (file, deps) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
      module, require: name => { if (!(name in deps)) throw Error(`Unexpected dependency: ${name}`); return deps[name]; },
      console, process, __dirname: path.join(__dirname, '../utils'),
    });
    return module.exports;
  };
  try {
    await db.exec(`
      CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT);
      CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT);
      CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);
      CREATE TABLE professional_site_access(professional_id UUID,kothi_id INT);
      CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,kothi_id INT,city_id INT,zone_id INT,ward_id INT,is_active BOOLEAN);
      CREATE TABLE professional_attendance(professional_id UUID,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,attempted_punch_in TIMESTAMPTZ,punch_approval_status TEXT);
      CREATE TABLE professional_leave_requests(professional_id UUID,requested_date DATE,status TEXT);
      CREATE TABLE professional_holidays(holiday_date DATE,city_id INT,zone_id INT,ward_id INT,kothi_id INT);
      CREATE FUNCTION professional_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT EXTRACT(DOW FROM $2)=0 $$;
      INSERT INTO wards VALUES(1,'Assigned'),(2,'Outside');
      INSERT INTO designation VALUES(1,'Project Head / Site Head'),(2,'HO Coordinator'),(3,'Head of Department');
      INSERT INTO professional_designation_assignments VALUES('${id(1)}',1),('${id(2)}',2),('${id(3)}',3);
      INSERT INTO professional_site_access VALUES('${id(1)}',1),('${id(2)}',1),('${id(3)}',1),('${id(4)}',1),('${id(1)}',1);
      INSERT INTO professional_employees VALUES('${id(10)}','A Employee','E001',1,1,1,1,TRUE),('${id(11)}','Outside Employee','E002',2,1,1,1,TRUE),('${id(12)}','Former Employee','E003',1,1,1,1,FALSE);
      INSERT INTO professional_attendance VALUES
        ('${id(10)}','2026-10-15','2026-10-15 05:30Z','2026-10-15 13:30Z',NULL,'accepted'),
        ('${id(10)}','2026-10-14',NULL,NULL,'2026-10-14 05:30Z','pending_pm'),
        ('${id(10)}','2026-10-13',NULL,NULL,'2026-10-13 05:30Z','pending_ho'),
        ('${id(10)}','2026-10-12',NULL,NULL,'2026-10-12 05:30Z','rejected'),
        ('${id(10)}','2026-09-15','2026-09-15 05:30Z','2026-09-15 07:30Z',NULL,'accepted'),
        ('${id(12)}','2026-09-15','2026-09-15 05:30Z','2026-09-15 13:30Z',NULL,'accepted'),
        ('${id(11)}','2026-10-15','2026-10-15 05:30Z',NULL,NULL,'accepted');
      INSERT INTO professional_leave_requests VALUES('${id(10)}','2026-10-10','approved');
      INSERT INTO professional_holidays VALUES('2026-10-09',1,NULL,NULL,NULL);
    `);
    const utility = load('../utils/professionalPunchCutoff.js', { fs, path, '../config/db': client });
    const router = { middleware: [], routes: [], use(fn) { this.middleware.push(fn); }, get(url, fn) { this.routes.push({ url, fn }); } };
    load('../routes/professionalTeamAttendanceRoutes.js', {
      express: { Router: () => router }, '../config/db': client,
      '../middleware/professionalAuth': (req, res, next) => next(),
      '../utils/professionalPunchCutoff': { capabilities: utility.capabilities, ensurePunchCutoffSchema: async () => {} },
      '../utils/professionalLeaveSchema': { ensureProfessionalLeaveSchema: async () => {} },
      '../utils/professionalWeeklyOff': { todayIST: () => '2026-10-15' },
    });
    async function request(actor, query = {}, url = '/') {
      const req = { professional: { professional_id: id(actor) }, query };
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      for (const fn of router.middleware) { let next = false; await fn(req, res, () => { next = true; }); if (!next) return res; }
      await router.routes.find(r => r.url === url).fn(req, res);
      return res;
    }
    for (const actor of [1, 2, 3]) {
      const res = await request(actor, { month: '2026-10' });
      assert.equal(res.code, 200);
      assert.equal(res.body.total, 31, 'Duplicate site assignments must not duplicate rows');
      assert.ok(res.body.data.every(r => r.site_id === 1 && r.employee_id === id(10)));
      assert.equal(res.body.summary.present, 1);
      assert.equal(res.body.summary['in-consideration'], 2);
      assert.equal(res.body.summary['punch-not-accepted'], 1);
      assert.equal(res.body.summary.upcoming, 14);
      assert.equal(res.body.summary['leave-approved'], 1);
      assert.equal(res.body.summary.holiday, 1);
      assert.equal(res.body.summary['weekly-off'], 4);
      const present = res.body.data.find(r => r.date === '2026-10-15');
      assert.equal(Number(present.hours_worked), 8);
    }
    assert.equal((await request(4)).code, 403, 'An assigned site alone must not grant access');
    assert.equal((await request(1, { site: '2' })).code, 403);
    assert.equal((await request(1, {}, '/sites')).body.data.length, 1);
    for (const query of [{month:'2026-13'}, {month:'2026-11'}, {month:'2026-02',date:'2026-02-30'}, {page:'0'}, {site:'no'}, {month:'2026-10',date:'2026-09-01'}]) assert.equal((await request(1,query)).code,400);
    const september = await request(1, { month: '2026-09' });
    assert.equal(september.body.total, 60, 'Historical punches retain inactive employees');
    assert.equal(september.body.data.length, 50);
    assert.equal(september.body.summary['half-day'], 1);
    const page2 = await request(1, { month: '2026-09', page: 2 });
    assert.equal(page2.body.data.length, 10);
    const keys = [...september.body.data, ...page2.body.data].map(r => r.employee_id + r.date);
    assert.equal(new Set(keys).size, 60);
    const filtered = await request(1, { month: '2026-09',date:'2026-09-15',search:'E001' });
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.data[0].status, 'half-day');
    assert.equal((await request(1,{search:'Outside'})).body.total,0);
    console.log('Team attendance: role access, site isolation, historical months, inactive history, statuses, filters and pagination passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
