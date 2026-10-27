// Isolated PostgreSQL tests; no live database connections.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');

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
    await db.exec(`CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,ward_id INT,phone TEXT,face_embedding TEXT,self_attendance_enabled BOOLEAN DEFAULT FALSE);
      CREATE TABLE attendance(attendance_id SERIAL PRIMARY KEY,emp_id INT,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,punch_in_image TEXT,punch_out_image TEXT,mid_shift_punch_in_time TIMESTAMPTZ,leave_type TEXT);
      INSERT INTO employee(emp_id,name,emp_code,ward_id) VALUES(1,'Regular Worker','REG1',1),(2,'Outside Regular','REG2',2),(3,'Professional Mirror','E001',1);
      INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(1,'2026-10-15','2026-10-15 09:00');`);
    for(const file of ['20261026_register_attendance.sql','20261026_supervisor_attendance.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));
    await db.query('UPDATE attendance SET supervisor_in_by=$1,supervisor_in_name=$2',[id(10),'Site Head']);
    const utility = load('../utils/professionalPunchCutoff.js', { fs, path, '../config/db': client });
    const router = { middleware: [], routes: [], use(fn) { this.middleware.push(fn); }, get(url, fn) { this.routes.push({ url, fn }); } };
    load('../routes/professionalTeamAttendanceRoutes.js', {
      express: { Router: () => router }, '../config/db': client,
      '../middleware/professionalAuth': (req, res, next) => next(),
      '../utils/professionalPunchCutoff': { capabilities: utility.capabilities, ensurePunchCutoffSchema: async () => {} },
      '../utils/professionalLeaveSchema': { ensureProfessionalLeaveSchema: async () => {} },
      '../utils/professionalWeeklyOff': { todayIST: () => '2026-10-15' },
      '../utils/regularTeamAttendance':require('../utils/regularTeamAttendance'),
      '../utils/combinedTeamAttendance':require('../utils/combinedTeamAttendance'),
    });
    async function request(actor, query = {}, url = '/') {
      const req = { professional: { professional_id: id(actor) }, query };
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      for (const fn of router.middleware) { let next = false; await fn(req, res, () => { next = true; }); if (!next) return res; }
      await router.routes.find(r => r.url === url).fn(req, res);
      return res;
    }
    for (const actor of [1, 2, 3]) {
      const res = await request(actor, { month: '2026-10',employeeType:'professional' });
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
    const september = await request(1, { month: '2026-09',employeeType:'professional' });
    assert.equal(september.body.total, 60, 'Historical punches retain inactive employees');
    assert.equal(september.body.data.length, 50);
    assert.equal(september.body.summary['half-day'], 1);
    const page2 = await request(1, { month: '2026-09', page: 2,employeeType:'professional' });
    assert.equal(page2.body.data.length, 10);
    const keys = [...september.body.data, ...page2.body.data].map(r => r.employee_id + r.date);
    assert.equal(new Set(keys).size, 60);
    const filtered = await request(1, { month: '2026-09',date:'2026-09-15',search:'E001',employeeType:'professional' });
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.data[0].status, 'half-day');
    assert.equal((await request(1,{search:'Outside'})).body.total,0);
    const all=await request(1,{employeeType:'all',month:'2026-10'});
    assert.equal(all.code,200);assert.equal(all.body.total,62);assert.equal(all.body.data.length,50);assert.equal(all.body.summary.present,2);
    assert.ok(all.body.data.some(r=>r.employee_kind==='regular'));assert.ok(all.body.data.some(r=>r.employee_kind==='professional'));assert.ok(all.body.data.every(r=>r.site_id===1));
    assert.equal(all.body.data.filter(r=>r.full_name==='Professional Mirror').length,0);
    const next=await request(1,{employeeType:'all',month:'2026-10',page:2});assert.equal(next.body.data.length,12);
    const combinedKeys=[...all.body.data,...next.body.data].map(r=>`${r.employee_kind}:${r.employee_id}:${r.date}`);assert.equal(new Set(combinedKeys).size,62);
    assert.equal(Object.values(all.body.summary).reduce((a,b)=>a+b,0),62);
    const dateAll=await request(1,{employeeType:'all',month:'2026-10',date:'2026-10-15'});assert.equal(dateAll.body.total,2);assert.equal(dateAll.body.summary.present,2);
    const defaultAll=await request(1,{month:'2026-10',date:'2026-10-15'});assert.equal(defaultAll.body.total,2);assert.ok(defaultAll.body.data.some(r=>r.employee_kind==='regular'));
    await db.query(`INSERT INTO register_attendance_requests(emp_id,site_id,requested_by,duration_days,reason,status) VALUES(1,1,$1,7,'No phone','rejected')`,[id(10)]);
    const afterRejection=await request(1,{month:'2026-10',date:'2026-10-15',search:'REG1'});assert.equal(afterRejection.body.total,1);assert.equal(afterRejection.body.data[0].attendance_mode,'supervisor');assert.equal(afterRejection.body.data[0].status,'present');
    const regularRow=dateAll.body.data.find(r=>r.employee_kind==='regular');assert.equal(regularRow.attendance_source,'supervisor');assert.equal(regularRow.supervisor_in_name,'Site Head');assert.equal(regularRow.punch_in,'09:00:00','Regular IST time must not be reparsed as a timezone-less device-local timestamp');
    assert.equal((await request(1,{employeeType:'regular',month:'2026-10',search:'REG1'})).body.total,31);
    assert.equal((await request(1,{employeeType:'all',month:'2026-10',search:'REG1'})).body.total,31);
    assert.equal((await request(1,{employeeType:'professional',month:'2026-10',search:'REG1'})).body.total,0);
    assert.equal((await request(1,{employeeType:'all',search:'Outside'})).body.total,0);
    assert.equal((await request(1,{employeeType:'all',site:'2'})).code,403);
    assert.equal((await request(1,{employeeType:'invalid'})).code,400);
    console.log('Team attendance: role access, site isolation, historical months, inactive history, statuses, filters and pagination passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
