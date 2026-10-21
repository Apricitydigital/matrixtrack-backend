// Read-only validation of the actual controllers. No schema initialization,
// migrations, photo signing, attendance changes or external notifications.
// Usage: node scripts/verify-professional-attendance-identity.js --live-read-only
if (!process.argv.includes('--live-read-only')) {
  console.log('Usage: node scripts/verify-professional-attendance-identity.js --live-read-only');
  process.exit(0);
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('pg');
require('dotenv').config({path:path.join(__dirname,'../.env')});
const identity = require('../utils/professionalAttendanceIdentity');
const {primaryId,profileIds} = require('../config/professionalAttendanceIdentities')[0];
const cutoff = require('../utils/professionalPunchCutoff');
const client = new Client({
  host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
  database:process.env.DB_NAME,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,
  options:'-c default_transaction_read_only=on',statement_timeout:30000,
});
const pool={query:(sql,params)=> /^\s*ALTER TABLE professional_attendance\b/i.test(sql)
  ? Promise.resolve({rows:[]}) // Existing controller's lazy schema initializer is intentionally disabled.
  : client.query(sql,params)};
const load=(file,deps)=>{
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers',file),'utf8'),{
    module,process,console,Date,Map,Set,Buffer,
    require:name=>{assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name];},
  });
  return module.exports;
};
const reportDependencies={
  '../utils/queryRunner':{runQueryWithTimeout:(text,values)=>client.query({text,values,query_timeout:30000})},
  '../utils/professionalAttendanceIdentity':identity,
  '../utils/professionalAccess':require('../utils/professionalAccess'),
  '../utils/s3SelfPunch':{getSignedS3Url:async value=>value},'../utils/logger':{error:(label,error)=>{throw Error(`${label}: ${error.message}`);}},
  '../config/db':pool,'../utils/professionalPunchCutoff':{ensurePunchCutoffSchema:async()=>{}},
  '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
};
const reports=load('professionalReportsController.js',reportDependencies);
const baseline=load('professionalReportsController.js',{
  ...reportDependencies,'../utils/professionalAttendanceIdentity':{
    withAttendanceIdentity:sql=>sql.replace(/\battendance_identity_profile_names\b/g,'professional_employees'),
    reviewedPaidDaySql:(person,date)=>`professional_is_paid_day(${person},${date})`,reviewedSearchSql:()=> 'FALSE',
  },
});
const run=async(controller,name,query,params={})=>{
  const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
  await controller[name]({query,params,user:{role:'admin'},cityScope:{all:true}},res);
  assert.equal(res.code,200,`${name}: ${JSON.stringify(res.body)}`);
  return res.body;
};
async function main(){
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const readOnly=(await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  assert.equal(readOnly,'on');
  const eligible=(await client.query(`WITH ${identity.linksSql} SELECT * FROM attendance_identity_links`)).rows;
  assert.equal(eligible.length,3,'Reviewed live group is no longer eligible; do not deploy until reviewed');
  const snapshot=(await client.query(`SELECT COUNT(*) AS n,md5(string_agg(md5(row_to_json(a)::text),'' ORDER BY a.id)) AS checksum
    FROM professional_attendance a WHERE professional_id=ANY($1::uuid[])`,[profileIds])).rows[0];
  const city=(await client.query('SELECT city_id FROM professional_employees WHERE id=$1',[primaryId])).rows[0].city_id;
  const unchangedSourceRows={};
  const relations={
    professional_employees:{key:'id',fields:'r.*'},
    professional_attendance:{key:'professional_id',fields:'r.id,r.professional_id,r.date,r.punch_in,r.punch_out,r.attempted_punch_in,r.punch_approval_status,r.auto_punched_out,r.out_address,r.punch_in_latitude,r.punch_in_longitude,r.punch_out_latitude,r.punch_out_longitude,r.punch_in_photo_url,r.punch_out_photo_url,r.ward_id,r.city_id,r.zone_id'},
    professional_leave_requests:{key:'professional_id',fields:'r.id,r.professional_id,r.requested_date,r.leave_type,r.status,r.requested_at,r.reviewed_at,r.review_note,r.reviewed_by,r.pm_reviewer_id,r.ho_reviewer_id,r.hod_reviewer_id'},
  };
  for(const [table,{key,fields}] of Object.entries(relations)){
    const sql=`SELECT count(*) AS n,md5(string_agg(md5(row_to_json(source_row)::text),'' ORDER BY source_row.id)) AS checksum
      FROM (SELECT ${fields} FROM ${table} r WHERE NOT r.${key}=ANY($1::uuid[])) source_row`;
    const before=(await client.query(sql,[profileIds])).rows[0];
    const after=(await client.query(identity.withAttendanceIdentity(sql,[profileIds]),[profileIds])).rows[0];
    assert.deepEqual(after,before,`An unlinked ${table} row changed`);
    unchangedSourceRows[table]=Number(before.n);
  }
  const range={city_id:city,start_date:'2026-09-01',end_date:'2026-09-30',limit:10000};
  const started=Date.now();
  console.log('All-location source row checksums match; comparing original September report for Manisha\'s city...');
  const oldAll=await run(baseline,'getDateRangeAttendanceSummary',range);
  const baselineMs=Date.now()-started;
  console.log(`Original report completed in ${baselineMs}ms; comparing corrected calculation...`);
  const nextStarted=Date.now();
  const newAll=await run(reports,'getDateRangeAttendanceSummary',range);
  const projectedMs=Date.now()-nextStarted;
  console.log(`Corrected report completed in ${projectedMs}ms.`);
  assert.ok(oldAll.pagination.pages<=1 && newAll.pagination.pages<=1,'Incomplete comparison; increase pagination coverage');
  const unaffected=rows=>rows.filter(r=>!profileIds.includes(r.professional_id)).sort((a,b)=>a.professional_id.localeCompare(b.professional_id));
  assert.deepEqual(JSON.parse(JSON.stringify(unaffected(newAll.data))),JSON.parse(JSON.stringify(unaffected(oldAll.data))),
    'An unlinked employee result changed');
  const mapped=newAll.data.filter(r=>profileIds.includes(r.professional_id));
  assert.equal(mapped.length,1);
  assert.equal(mapped[0].attendance_count,29);assert.equal(mapped[0].payable_days,29);assert.equal(mapped[0].absent_days,1);
  for(const id of profileIds){
    const details=await run(reports,'getDateRangeAttendanceDetails',{...range,professional_id:id});
    assert.equal(details.data.records.length,30);assert.equal(details.data.attendance_days,29);assert.equal(details.data.payable_days,29);
    const month=await run(reports,'getEmployeeAttendance',{month:'2026-09'},{id});
    assert.equal(month.data.filter(r=>r.status==='present').length,28);
    assert.equal(month.data.filter(r=>r.status==='half-day').length,1);
  }
  const search=await run(reports,'getDateRangeAttendanceSummary',{...range,search:'CH00137'});
  assert.ok(search.data.some(r=>r.professional_id===primaryId && r.attendance_count===29));
  for(const month of ['2026-08','2026-10']){
    const raw=(await client.query(`SELECT count(DISTINCT date)::int AS n FROM professional_attendance
      WHERE professional_id=ANY($1::uuid[]) AND to_char(date,'YYYY-MM')=$2 AND punch_in IS NOT NULL`,[profileIds,month])).rows[0].n;
    const monthly=await run(reports,'getEmployeeAttendance',{month},{id:primaryId});
    assert.equal(monthly.data.filter(r=>r.punch_in).length,raw,`${month}: history lost`);
  }
  const app=load('professionalAttendanceController.js',{
    '../config/db':pool,'../utils/professionalAttendanceIdentity':identity,
    '../utils/professionalPunchCutoff':{ensurePunchCutoffSchema:async()=>{},loadPunchApprovals:cutoff.loadPunchApprovals,approvalProgress:cutoff.approvalProgress},
    '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
    '../utils/logger':{error:(label,error)=>{throw Error(`${label}: ${error.message}`);}},
    '../utils/faceService':{},'../config/awsConfig':{},'../utils/s3SelfPunch':{},'../utils/cityTrafficCost':{},
    './professionalGeofenceController':{},'./consentController':{},
  });
  const res={json(body){this.body=body;},status(code){throw Error(`App monthly failed ${code}`);}};
  await app.getMonthlyAttendance({professional:{professional_id:primaryId},query:{month:'2026-09'}},res);
  assert.equal(res.body.summary.total_present,28);assert.equal(res.body.summary.total_half_day,1);
  assert.equal(res.body.summary.total_absent,1);assert.equal(res.body.summary.total_payable_days,29);
  const after=(await client.query(`SELECT COUNT(*) AS n,md5(string_agg(md5(row_to_json(a)::text),'' ORDER BY a.id)) AS checksum
    FROM professional_attendance a WHERE professional_id=ANY($1::uuid[])`,[profileIds])).rows[0];
  assert.deepEqual(after,snapshot,'Stored attendance changed during verification');
  console.log(JSON.stringify({transaction_read_only:readOnly,unchanged_all_location_source_rows:unchangedSourceRows,
    comparison_city_id:city,unchanged_other_september_report_rows_in_city:unaffected(newAll.data).length,
    baseline_ms:baselineMs,corrected_ms:projectedMs,manisha_web_punch_dates:mapped[0].attendance_count,
    manisha_app:res.body.summary,manisha_source_records_unchanged:true,
    verified:['all three profile-specific links','old employee code search','September details and monthly','August and October history']},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
  await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});await require('../config/db').end();
});
