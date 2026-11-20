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
      CREATE TABLE self_attendance_records_blocks(self_attendance_id UUID PRIMARY KEY,is_blocked BOOLEAN);
      CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT);
      CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT);
      CREATE TABLE self_attendance_designation_assignments(self_attendance_id UUID,designation_id INT);
      CREATE TABLE self_attendance_site_access(self_attendance_id UUID,kothi_id INT);
      CREATE TABLE self_attendance_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,kothi_id INT,city_id INT,zone_id INT,ward_id INT,is_active BOOLEAN);
      CREATE TABLE self_attendance_records(self_attendance_id UUID,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,attempted_punch_in TIMESTAMPTZ,punch_approval_status TEXT);
      CREATE TABLE self_attendance_leave_requests(self_attendance_id UUID,requested_date DATE,status TEXT);
      CREATE TABLE self_attendance_holidays(holiday_date DATE,city_id INT,zone_id INT,ward_id INT,kothi_id INT);
      CREATE FUNCTION self_attendance_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT EXTRACT(DOW FROM $2)=0 $$;
      INSERT INTO wards VALUES(1,'Assigned'),(2,'Outside');
      INSERT INTO designation VALUES(1,'Project Head / Site Head'),(2,'HO Coordinator'),(3,'Head of Department');
      INSERT INTO self_attendance_designation_assignments VALUES('${id(1)}',1),('${id(2)}',2),('${id(3)}',3);
      INSERT INTO self_attendance_site_access VALUES('${id(1)}',1),('${id(2)}',1),('${id(3)}',1),('${id(4)}',1),('${id(1)}',1);
      INSERT INTO self_attendance_employees VALUES('${id(10)}','A Employee','E001',1,1,1,1,TRUE),('${id(11)}','Outside Employee','E002',2,1,1,1,TRUE),('${id(12)}','Former Employee','E003',1,1,1,1,FALSE);
      INSERT INTO self_attendance_records VALUES
        ('${id(10)}','2026-10-15','2026-10-15 05:30Z','2026-10-15 13:30Z',NULL,'accepted'),
        ('${id(10)}','2026-10-14',NULL,NULL,'2026-10-14 05:30Z','pending_pm'),
        ('${id(10)}','2026-10-13',NULL,NULL,'2026-10-13 05:30Z','pending_ho'),
        ('${id(10)}','2026-10-12',NULL,NULL,'2026-10-12 05:30Z','rejected'),
        ('${id(10)}','2026-09-15','2026-09-15 05:30Z','2026-09-15 07:30Z',NULL,'accepted'),
        ('${id(12)}','2026-09-15','2026-09-15 05:30Z','2026-09-15 13:30Z',NULL,'accepted'),
        ('${id(11)}','2026-10-15','2026-10-15 05:30Z',NULL,NULL,'accepted');
      INSERT INTO self_attendance_leave_requests VALUES('${id(10)}','2026-10-10','approved');
      INSERT INTO self_attendance_holidays VALUES('2026-10-09',1,NULL,NULL,NULL);
    `);
    await db.exec(`CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,ward_id INT,phone TEXT,face_embedding TEXT,self_attendance_enabled BOOLEAN DEFAULT FALSE);
      CREATE TABLE attendance(attendance_id SERIAL PRIMARY KEY,emp_id INT,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,punch_in_image TEXT,punch_out_image TEXT,mid_shift_punch_in_time TIMESTAMPTZ,leave_type TEXT);
      INSERT INTO employee(emp_id,name,emp_code,ward_id) VALUES(1,'Regular Worker','REG1',1),(2,'Outside Regular','REG2',2),(3,'SelfAttendance Mirror','E001',1);
      INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(1,'2026-10-15','2026-10-15 09:00');`);
    for(const file of ['20261026_register_attendance.sql','20261026_supervisor_attendance.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));
    await db.query('UPDATE attendance SET supervisor_in_by=$1,supervisor_in_name=$2',[id(10),'Site Head']);
    const utility = load('../utils/selfAttendancePunchCutoff.js', { fs, path, '../config/db': client });
    const router = { middleware: [], routes: [], use(fn) { this.middleware.push(fn); }, get(url, fn) { this.routes.push({ url, fn }); } };
    load('../routes/selfAttendanceTeamAttendanceRoutes.js', {
      express: { Router: () => router }, '../config/db': client,
      '../middleware/selfAttendanceAuth': (req, res, next) => next(),
      '../utils/selfAttendancePunchCutoff': { capabilities: utility.capabilities, ensurePunchCutoffSchema: async () => {} },
      '../utils/selfAttendanceLeaveSchema': { ensureSelfAttendanceLeaveSchema: async () => {} },
      '../utils/attendanceBlockReporting':require('../utils/attendanceBlockReporting'),
      '../utils/selfAttendanceRecordsBlock':{ensureAttendanceBlockSchema:async()=>{}},
      '../utils/selfAttendanceWeeklyOff': { todayIST: () => '2026-10-15' },
      '../utils/regularTeamAttendance':require('../utils/regularTeamAttendance'),
      '../utils/combinedTeamAttendance':require('../utils/combinedTeamAttendance'),
      '../utils/teamAttendanceEmployeeSummary':require('../utils/teamAttendanceEmployeeSummary'),
    });
    async function request(actor, query = {}, url = '/') {
      const req = { self_attendance: { self_attendance_id: id(actor) }, query };
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      for (const fn of router.middleware) { let next = false; await fn(req, res, () => { next = true; }); if (!next) return res; }
      await router.routes.find(r => r.url === url).fn(req, res);
      return res;
    }
    for (const actor of [1, 2, 3]) {
      const res = await request(actor, { month: '2026-10',employeeType:'self_attendance' });
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
    const september = await request(1, { month: '2026-09',employeeType:'self_attendance' });
    assert.equal(september.body.total, 60, 'Historical punches retain inactive employees');
    assert.equal(september.body.data.length, 50);
    assert.equal(september.body.summary['half-day'], 1);
    const page2 = await request(1, { month: '2026-09', page: 2,employeeType:'self_attendance' });
    assert.equal(page2.body.data.length, 10);
    const keys = [...september.body.data, ...page2.body.data].map(r => r.employee_id + r.date);
    assert.equal(new Set(keys).size, 60);
    const filtered = await request(1, { month: '2026-09',date:'2026-09-15',search:'E001',employeeType:'self_attendance' });
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.data[0].status, 'half-day');
    assert.equal((await request(1,{search:'Outside'})).body.total,0);
    const all=await request(1,{employeeType:'all',month:'2026-10'});
    assert.equal(all.code,200);assert.equal(all.body.total,62);assert.equal(all.body.data.length,50);assert.equal(all.body.summary.present,2);
    assert.ok(all.body.data.some(r=>r.employee_kind==='regular'));assert.ok(all.body.data.some(r=>r.employee_kind==='self_attendance'));assert.ok(all.body.data.every(r=>r.site_id===1));
    assert.equal(all.body.data.filter(r=>r.full_name==='SelfAttendance Mirror').length,0);
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
    assert.equal((await request(1,{employeeType:'self_attendance',month:'2026-10',search:'REG1'})).body.total,0);
    assert.equal((await request(1,{employeeType:'all',search:'Outside'})).body.total,0);
    assert.equal((await request(1,{employeeType:'all',site:'2'})).code,403);
    assert.equal((await request(1,{employeeType:'invalid'})).code,400);
    const grouped=await request(1,{month:'2026-10',view:'employees'});
    assert.equal(grouped.code,200);assert.equal(grouped.body.view,'employees');assert.equal(grouped.body.total,2);
    const person=grouped.body.data.find(r=>r.employee_kind==='self_attendance');
    assert.equal(person.days.length,31,'Employee details must cover the full month, beyond daily pagination');
    assert.equal(person.working_days,12,'Exclude future dates, weekly offs and holiday from elapsed working days');
    assert.equal(person.attended_days,1,'Pending and rejected punch attempts are not attendance');
    assert.equal(person.pending_days,2);assert.equal(person.leave_days,1);assert.equal(person.absent_days,7);
    const punch=person.days.find(d=>d.date==='2026-10-15');
    assert.equal(punch.site_name,'Assigned');assert.ok(punch.punch_in);assert.ok(punch.punch_out);
    assert.equal(grouped.body.data.find(r=>r.employee_kind==='regular').days.length,31);
    assert.equal((await request(1,{month:'2026-10',view:'employees',employeeType:'regular'})).body.total,1);
    assert.equal((await request(1,{month:'2026-10',view:'employees',site:'2'})).code,403);
    assert.equal((await request(1,{month:'2026-10',view:'employees',search:'Outside'})).body.total,0);
    const half=await request(1,{month:'2026-09',view:'employees',search:'E001'});
    assert.equal(half.body.data[0].attended_days,1);assert.equal(half.body.data[0].half_days,1);
    const singleDay=await request(1,{month:'2026-10',view:'employees',date:'2026-10-15'});
    assert.ok(singleDay.body.data.every(r=>r.working_days===1&&r.attended_days===1&&r.days.length===1));
    assert.equal((await request(1,{view:'invalid'})).code,400);
    await db.exec(`INSERT INTO employee(emp_id,name,emp_code,ward_id)
      SELECT n,'Worker '||n,'CODE'||n,1 FROM generate_series(20,70) n`);
    const firstEmployees=await request(1,{month:'2026-10',view:'employees'});
    const secondEmployees=await request(1,{month:'2026-10',view:'employees',page:2});
    assert.equal(firstEmployees.body.total,53);assert.equal(firstEmployees.body.data.length,50);assert.equal(secondEmployees.body.data.length,3);
    assert.equal(new Set([...firstEmployees.body.data,...secondEmployees.body.data].map(r=>r.employee_kind+':'+r.employee_id)).size,53);
    assert.ok([...firstEmployees.body.data,...secondEmployees.body.data].every(r=>r.days.length===31));
    // A name that normally sorts first must move beyond the page boundary.
    await db.query('INSERT INTO self_attendance_records_blocks VALUES($1,TRUE)',[id(10)]);
    const blockedFirst=await request(1,{month:'2026-10',view:'employees'});
    const blockedSecond=await request(1,{month:'2026-10',view:'employees',page:2});
    assert.ok(blockedFirst.body.data.every(r=>!r.is_attendance_blocked));
    const blockedPerson=blockedSecond.body.data.at(-1);
    assert.equal(blockedPerson.employee_id,id(10));assert.equal(blockedPerson.is_attendance_blocked,true);
    assert.equal(blockedPerson.attended_days,person.attended_days);assert.equal(blockedPerson.absent_days,person.absent_days);
    assert.deepEqual(blockedSecond.body.summary,firstEmployees.body.summary,'Block state does not rewrite attendance statuses');
    const blockedDay=await request(1,{month:'2026-10',date:'2026-10-15',page:2});
    assert.equal(blockedDay.body.data.at(-1).employee_id,id(10));assert.equal(blockedDay.body.data.at(-1).status,'present');
    const selfOnly=await request(1,{month:'2026-10',employeeType:'self_attendance'});
    assert.ok(selfOnly.body.data.every(r=>r.is_attendance_blocked));
    assert.equal((await request(1,{month:'2026-10',search:'Outside'})).body.total,0,'Blocking does not expand site visibility');
    await db.query('UPDATE self_attendance_records_blocks SET is_blocked=FALSE WHERE self_attendance_id=$1',[id(10)]);
    const restored=await request(1,{month:'2026-10',view:'employees'});
    assert.equal(restored.body.data[0].employee_id,id(10));assert.equal(restored.body.data[0].is_attendance_blocked,false);
    console.log('Team attendance: role access, site isolation, historical months, inactive history, statuses, filters and pagination passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
