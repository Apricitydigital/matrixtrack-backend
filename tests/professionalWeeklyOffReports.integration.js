const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
module.exports = async function verifyReports(client) {
  await client.query(`ALTER TABLE professional_employees ADD COLUMN mobile TEXT, ADD COLUMN email TEXT, ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN request_id UUID, ADD COLUMN selfie_url TEXT, ADD COLUMN face_locked BOOLEAN DEFAULT TRUE;
    ALTER TABLE sectors ADD COLUMN sector_name TEXT;
    ALTER TABLE professional_attendance ADD COLUMN ward_id INT, ADD COLUMN city_id INT, ADD COLUMN zone_id INT, ADD COLUMN kothi_id INT;
    ALTER TABLE professional_leave_requests ADD COLUMN leave_type TEXT, ADD COLUMN reviewed_by INT, ADD COLUMN review_note TEXT, ADD COLUMN reviewed_at TIMESTAMPTZ, ADD COLUMN requested_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN pm_reviewer_id UUID, ADD COLUMN ho_reviewer_id UUID, ADD COLUMN hod_reviewer_id UUID;
    CREATE TABLE self_punch_requests(id UUID,ward_id INT,kothi_id INT);`);
  let reportQueryCount = 0;
  const dependencies = {
    '../utils/professionalAttendanceBlock': require('./helpers/unblockedAttendance'),
    '../utils/professionalAttendanceIdentity': require('../utils/professionalAttendanceIdentity'),
    '../utils/professionalPunchCutoff': { ensurePunchCutoffSchema: async () => client.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261014_professional_punch_cutoff.sql'),'utf8')) },
    '../utils/queryRunner': { runQueryWithTimeout: (sql,params) => { reportQueryCount++; return client.query(sql,params); } },
    '../utils/professionalAccess': { buildVisibilityScope: () => ({cte:'',whereClause:'1=1',params:[]}) },
    '../utils/s3SelfPunch': { getSignedS3Url: async url => url },
    '../utils/logger': {error:(label,e)=>console.error(label,e.message)}, '../config/db': { query: (sql,params) => client.query(sql,params) },
    '../utils/professionalLeaveSchema': { ensureProfessionalLeaveSchema: async () => {} },
  };
  const moduleRef = { exports:{} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers/professionalReportsController.js'),'utf8'), {require:name=>dependencies[name],module:moduleRef,console,Date,Promise,Number,String,parseInt,parseFloat,Math});
  const person='00000000-0000-4000-8000-000000000001';
  // The route suite changes this employee's weekly off using today's date.
  // Restore the fixed Tuesday schedule used by these October report fixtures.
  await client.query(`DELETE FROM professional_week_off_versions WHERE professional_id=$1 AND effective_from>'2026-10-13'`, [person]);
  await client.query(`UPDATE professional_week_off SET week_off_days=ARRAY[2],effective_from='2026-10-13' WHERE professional_id=$1`,[person]);
  const run=async(name,query,params={})=>{
    const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await moduleRef.exports[name]({query,params,user:{role:'admin'},cityScope:{all:true}},res);
    assert.equal(res.code,200,`${name}: ${res.body?.message || ''}`);return res.body;
  };
  const summary=await run('getDateRangeAttendanceSummary',{professional_id:person,start_date:'2026-10-13',end_date:'2026-10-20'});
  const row=summary.data[0];
  assert.equal(row.week_off_days_count,2);assert.equal(row.payable_days,2);assert.equal(row.absent_days,6);
  const details=await run('getDateRangeAttendanceDetails',{professional_id:person,start_date:'2026-10-13',end_date:'2026-10-20'});
  assert.equal(details.data.records.length,8);assert.equal(details.data.weekly_off_days,2);assert.equal(details.data.payable_days,2);
  const monthly=await run('getEmployeeAttendance',{month:'2026-10'},{id:person});
  assert.equal(monthly.data.length,31);assert.ok(monthly.data.some(r=>r.status==='weekly-off'));
  const daily=await run('getAttendanceList',{professional_id:person,date:'2026-10-20'});
  assert.equal(daily.data[0].is_weekly_off,true);
  reportQueryCount=0;
  const dashboard=await run('getAttendanceSummary',{professional_id:person,date:'2026-10-20'});
  assert.equal(reportQueryCount,1,'Dashboard shares one scoped/deduplicated set in one report query');
  assert.equal(dashboard.data.weekly_off_professionals,1);assert.equal(dashboard.data.absent_professionals,0);
  const presentDay=await run('getAttendanceSummary',{professional_id:person,date:'2026-10-13'});
  assert.equal(presentDay.data.present_professionals,1);
  assert.equal(presentDay.data.leave_professionals,0,'Worked approved leave must not count twice');
  for(const filters of [{month:'2026-10'},{start_date:'2026-10-13',end_date:'2026-10-20'}]) {
    reportQueryCount=0;
    const result=await run('getAttendanceSummary',{professional_id:person,...filters});
    assert.equal(reportQueryCount,1);
    assert.equal(result.data.present_professionals,1);
    assert.equal(result.data.weekly_off_professionals,0);
  }
  const emptySummary=await run('getAttendanceSummary',{professional_id:'00000000-0000-4000-8000-999999999999',date:'2026-10-20'});
  assert.equal(emptySummary.data.total_professionals,0);assert.deepEqual(emptySummary.data.by_ward,[]);
  await client.query(`INSERT INTO professional_holidays(holiday_date,city_id,kothi_id) VALUES('2026-10-14',1,1)`);
  const paidHoliday=await run('getDateRangeAttendanceSummary',{professional_id:person,start_date:'2026-10-13',end_date:'2026-10-14'});
  assert.equal(paidHoliday.data[0].payable_days,2,'Non-working holiday adds one payable date; overlap on the other date counts once');
  const holidayDetails=await run('getDateRangeAttendanceDetails',{professional_id:person,start_date:'2026-10-13',end_date:'2026-10-14'});
  assert.equal(holidayDetails.data.payable_days,2);assert.equal(holidayDetails.data.records.find(r=>new Date(r.date).toISOString().slice(0,10)==='2026-10-14').is_holiday,true);
  const holidaySummary=await run('getAttendanceSummary',{professional_id:person,date:'2026-10-14'});
  assert.equal(holidaySummary.data.holiday_professionals,1);assert.equal(holidaySummary.data.absent_professionals,0);
  const holidayList=await run('getAttendanceList',{professional_id:person,date:'2026-10-14'});
  assert.equal(holidayList.data[0].is_holiday,true);
  const holidayMonth=await run('getEmployeeAttendance',{month:'2026-10'},{id:person});
  assert.ok(holidayMonth.data.some(r=>r.status==='holiday'&&r.is_payable_day));
  console.log('PASS: actual daily/monthly attendance, detailed timeline, dashboard, site holidays and overlap-safe date-range payroll queries.');
  await require('./professionalAttendanceIdentity.integration')(client, dependencies);
};
