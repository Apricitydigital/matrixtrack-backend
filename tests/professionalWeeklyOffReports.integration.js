const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
module.exports = async function verifyReports(client) {
  await client.query(`ALTER TABLE professional_employees ADD COLUMN mobile TEXT, ADD COLUMN email TEXT, ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW(), ADD COLUMN request_id UUID, ADD COLUMN selfie_url TEXT;
    ALTER TABLE sectors ADD COLUMN sector_name TEXT;
    ALTER TABLE professional_attendance ADD COLUMN ward_id INT, ADD COLUMN city_id INT, ADD COLUMN zone_id INT, ADD COLUMN kothi_id INT;
    ALTER TABLE professional_leave_requests ADD COLUMN leave_type TEXT, ADD COLUMN reviewed_by INT, ADD COLUMN review_note TEXT, ADD COLUMN reviewed_at TIMESTAMPTZ, ADD COLUMN requested_at TIMESTAMPTZ DEFAULT NOW();
    CREATE TABLE self_punch_requests(id UUID,ward_id INT,kothi_id INT);`);
  const dependencies = {
    '../utils/queryRunner': { runQueryWithTimeout: (sql,params) => client.query(sql,params) },
    '../utils/professionalAccess': { buildVisibilityScope: () => ({cte:'',whereClause:'1=1',params:[]}) },
    '../utils/s3SelfPunch': { getSignedS3Url: async url => url },
    '../utils/logger': {error:(label,e)=>console.error(label,e.message)}, '../config/db': { query: (sql,params) => client.query(sql,params) },
    '../utils/professionalLeaveSchema': { ensureProfessionalLeaveSchema: async () => {} },
  };
  const moduleRef = { exports:{} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers/professionalReportsController.js'),'utf8'), {require:name=>dependencies[name],module:moduleRef,console,Date,Promise,Number,String,parseInt,parseFloat,Math});
  const person='00000000-0000-4000-8000-000000000001';
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
  const dashboard=await run('getAttendanceSummary',{professional_id:person,date:'2026-10-20'});
  assert.equal(dashboard.data.weekly_off_professionals,1);assert.equal(dashboard.data.absent_professionals,0);
  console.log('PASS: actual daily/monthly attendance, detailed timeline, dashboard and date-range payroll queries.');
};
