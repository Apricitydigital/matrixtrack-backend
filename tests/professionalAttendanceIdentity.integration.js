// Executed by verify-professional-weekly-off.js --local-pg in an isolated DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const identity = require('../utils/professionalAttendanceIdentity');
const groups = require('../config/professionalAttendanceIdentities');

module.exports = async function verifyAttendanceIdentity(client, reportDependencies) {
  await client.query(`ALTER TABLE professional_leave_requests ADD COLUMN IF NOT EXISTS reason TEXT;
    ALTER TABLE professional_holidays ADD COLUMN IF NOT EXISTS holiday_name TEXT, ADD COLUMN IF NOT EXISTS description TEXT;`);
  const { primaryId, profileIds } = groups[0];
  const [, olderId, emptyId] = profileIds;
  const stranger = '00000000-0000-4000-8000-000000000090';
  const sharedEmailOther = '00000000-0000-4000-8000-000000000091';
  const load = (file, dependencies) => {
    const module = {exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8'), {
      module, require:name => { assert.ok(name in dependencies,`Unexpected dependency ${name}`); return dependencies[name]; },
      process,console,Date,Map,Set,Buffer,
    });
    return module.exports;
  };
  const response = () => ({code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
  const run = async (controller, method, query, params={}, cityScope={all:true}) => {
    const res=response();
    await controller[method]({query,params,user:{role:'admin'},cityScope},res);
    assert.equal(res.code,200,`${method}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const reports=load('../controllers/professionalReportsController.js',{
    ...reportDependencies,
    '../utils/professionalAccess':require('../utils/professionalAccess'),
  });
  const baselineReports=load('../controllers/professionalReportsController.js',{
    ...reportDependencies,
    '../utils/professionalAttendanceIdentity':{
      withAttendanceIdentity:sql=>sql.replace(/\battendance_identity_profile_names\b/g,'professional_employees'),
      reviewedPaidDaySql:(person,date)=>`professional_is_paid_day(${person},${date})`,
      reviewedSearchSql:()=> 'FALSE',
    },
    '../utils/professionalAccess':require('../utils/professionalAccess'),
  });
  for (const [i,id] of profileIds.entries()) {
    await client.query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,email,city_id,zone_id,ward_id,kothi_id,is_active,created_at)
      VALUES($1,'Manisha Dakwani',$2,$3,'shared@example.test',1,1,1,1,true,$4)`,
    [id,i===1?'CH00137':'CH00237',i===2?'different-mobile':'original-mobile',`2026-08-0${i+1}`]);
  }
  for(const [id,name,mobile] of [[stranger,'Unrelated same email','other-mobile'],[sharedEmailOther,'Another unrelated','another-mobile']]) {
    await client.query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,email,city_id,zone_id,ward_id,kothi_id,is_active)
      VALUES($1,$2,$2,$3,'shared@example.test',1,1,1,1,true)`,[id,name,mobile]);
    await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_out)
      VALUES($1,'2026-09-14','2026-09-14T09:00:00+05:30','2026-09-14T17:00:00+05:30')`,[id]);
  }
  for(let day=1;day<=30;day++) {
    if(day===14)continue;
    const date=`2026-09-${String(day).padStart(2,'0')}`;
    const noOut=day<=3 || day===19 || day>=21;
    await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_out,punch_approval_status)
      VALUES($1,$2,$3,$4,'accepted')`,[day<=18?olderId:primaryId,date,`${date}T09:00:00+05:30`,noOut?null:`${date}T${day===5?'09':'17'}:01:00+05:30`]);
  }
  for(const [month,days,id] of [['08',24,olderId],['10',20,primaryId]]) {
    for(let day=1;day<=days;day++) {
      const date=`2026-${month}-${String(day).padStart(2,'0')}`;
      await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_out,punch_approval_status)
        VALUES($1,$2,$3,$4,'accepted')`,[id,date,`${date}T09:00:00+05:30`,`${date}T17:00:00+05:30`]);
    }
  }
  const range={start_date:'2026-09-01',end_date:'2026-09-30',limit:10000};
  await client.query(`INSERT INTO professional_leave_requests(professional_id,requested_date,status,pm_reviewer_id)
    VALUES($1,'2026-09-13','approved',$2)`,[stranger,olderId]);
  const sourceBefore=await client.query('SELECT * FROM professional_attendance ORDER BY id');
  const oldAll=await run(baselineReports,'getDateRangeAttendanceSummary',range);
  const newAll=await run(reports,'getDateRangeAttendanceSummary',range);
  const unrelated=rows=>rows.filter(r=>!profileIds.includes(r.professional_id)).sort((a,b)=>a.professional_id.localeCompare(b.professional_id));
  assert.deepEqual(JSON.parse(JSON.stringify(unrelated(newAll.data))),JSON.parse(JSON.stringify(unrelated(oldAll.data))),
    'All unrelated report rows retain every baseline field, including shared-email users');
  const mapped=newAll.data.filter(r=>profileIds.includes(r.professional_id));
  assert.equal(mapped.length,1,'One Manisha row replaces the split/empty aliases');
  assert.equal(mapped[0].professional_id,primaryId);
  assert.equal(mapped[0].attendance_count,29);
  assert.equal(mapped[0].payable_days,29);
  assert.equal(mapped[0].absent_days,1);
  assert.equal(mapped[0].not_punched_out_days,14);
  assert.equal((await run(reports,'getDateRangeAttendanceSummary',{...range,search:'CH00137'})).data[0].attendance_count,29,'Old employee code remains searchable');
  assert.equal((await run(reports,'getDateRangeAttendanceSummary',{...range,professional_id:olderId})).data[0].attendance_count,29,'Old employee-specific links resolve to the complete history');
  for(const [month,expected] of [['08',24],['10',20]]) {
    const result=await run(reports,'getDateRangeAttendanceSummary',{professional_id:primaryId,start_date:`2026-${month}-01`,end_date:`2026-${month}-${month==='08'?'31':'20'}`});
    assert.equal(result.data[0].attendance_count,expected,'Other months preserve history');
  }
  const details=(await run(reports,'getDateRangeAttendanceDetails',{...range,professional_id:emptyId})).data;
  assert.equal(details.records.length,30);
  assert.equal(details.attendance_days,29);
  assert.equal(details.payable_days,29);
  const month=await run(reports,'getEmployeeAttendance',{month:'2026-09'},{id:olderId});
  assert.equal(month.data.filter(r=>r.status==='present').length,28);
  assert.equal(month.data.filter(r=>r.status==='half-day').length,1);
  assert.equal(month.data.filter(r=>r.status==='absent').length,1);
  assert.equal((await run(reports,'getAttendanceList',{professional_id:emptyId,date:'2026-09-01'})).data[0].professional_id,primaryId);
  const dashboard=await run(reports,'getAttendanceSummary',{professional_id:emptyId,...range});
  assert.equal(dashboard.data.total_professionals,1);
  assert.equal(dashboard.data.total_present_days,29);
  const employeeList=await run(reports,'getEmployeesList',{search:'Manisha'});
  assert.equal(employeeList.pagination.total,1);
  const denied=response();
  await reports.getDateRangeAttendanceDetails({query:{...range,professional_id:olderId},user:{role:'admin'},cityScope:{all:false,ids:[2]}},denied);
  assert.equal(denied.code,404,'Identity links do not bypass city authorization');

  let faceCalls=0;
  const tx={release(){},query:async(sql,params)=>{
    if(sql==='BEGIN')return client.query('SAVEPOINT identity_punch');
    if(sql==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT identity_punch');
    if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT identity_punch');
    return client.query(sql,params);
  }};
  const pool={query:(sql,params)=>client.query(sql,params),connect:async()=>tx};
  const app=load('../controllers/professionalAttendanceController.js',{
    '../utils/professionalAttendanceBlock':require('./helpers/unblockedAttendance'),
    '../config/db':pool,'../utils/professionalAttendanceIdentity':identity,
    '../utils/professionalPunchCutoff':{ensurePunchCutoffSchema:async()=>{},loadPunchApprovals:async()=>new Map(),approvalProgress:()=>null},
    '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
    '../utils/logger':{error:(label,e)=>console.error(label,e),info(){},warn(){}},
    '../utils/faceService':{verifyFaceMatch:async()=>{faceCalls++;throw Error('Duplicate must stop before face work');}},
    '../config/awsConfig':{},'../utils/s3SelfPunch':{},'../utils/cityTrafficCost':{},
    './professionalGeofenceController':{validateProfessionalGeofenceAccess:async()=>{throw Error('Duplicate must stop before geo work');}},
    './consentController':{},
  });
  const appResult=response();
  await app.getMonthlyAttendance({professional:{professional_id:primaryId},query:{month:'2026-09'}},appResult);
  assert.equal(appResult.code,200);
  assert.equal(appResult.body.summary.total_present,28);
  assert.equal(appResult.body.summary.total_half_day,1);
  assert.equal(appResult.body.summary.total_absent,1,'Unverified same-email users must not fill September 14');
  assert.equal(appResult.body.summary.total_payable_days,29);
  assert.deepEqual((await client.query('SELECT * FROM professional_attendance ORDER BY id')).rows,sourceBefore.rows,'Reports never modify stored history');

  const middleware=load('../utils/professionalAttendanceIdentity.js',{
    '../config/professionalAttendanceIdentities':groups,'../config/db':pool,
  }).resolveAttendanceIdentity;
  for(const id of profileIds) {
    const req={professional:{professional_id:id},route:{path:'/attendance/punch-in'}};
    let called=false;await middleware(req,response(),()=>{called=true;});
    assert.equal(called,true);assert.equal(req.professional.professional_id,primaryId,'Every verified login uses the same serialized punch account');
  }
  const unknownReq={professional:{professional_id:stranger},route:{path:'/attendance/punch-in'}};
  await middleware(unknownReq,response(),()=>{});
  assert.equal(unknownReq.professional.professional_id,stranger,'Unreviewed shared-email accounts are unchanged');
  await client.query(`DELETE FROM professional_attendance WHERE professional_id=ANY($1::uuid[]) AND date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date`,[profileIds]);
  await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_approval_status)
    VALUES($1,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,NOW(),'accepted')`,[olderId]);
  for(const endpoint of ['/attendance/status','/attendance/punch-out']) {
    const req={professional:{professional_id:emptyId},route:{path:endpoint}};
    await middleware(req,response(),()=>{});
    assert.equal(req.professional.professional_id,olderId,'An existing session can still punch out on its original source row');
  }
  const duplicate=response();
  await app.punchIn({professional:{professional_id:primaryId},body:{selfie_base64:'eA=='},headers:{}},duplicate);
  assert.equal(duplicate.code,409,'A punch on a historical alias prevents a second punch');
  assert.equal(faceCalls,0);
  await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_approval_status)
    VALUES($1,'2026-09-01','2026-09-01T09:00:00+05:30','accepted')`,[primaryId]);
  const conflict=response();let conflictNext=false;
  await middleware({professional:{professional_id:emptyId},route:{path:'/attendance/punch-in'}},conflict,()=>{conflictNext=true;});
  assert.equal(conflictNext,false);assert.equal(conflict.code,409,'Historical conflicts fail closed for reviewed attendance calls');
  const rawConflicts=await client.query(identity.withAttendanceIdentity('SELECT * FROM professional_employees WHERE full_name=$1'),['Manisha Dakwani']);
  assert.equal(rawConflicts.rows.length,3,'Conflicting groups remain separate rather than silently picking a source row');
  await client.query(`DELETE FROM professional_attendance WHERE professional_id=$1 AND date='2026-09-01'`,[primaryId]);
  await client.query('UPDATE professional_employees SET city_id=2 WHERE id=$1',[emptyId]);
  const moved=response();await middleware({professional:{professional_id:emptyId}},moved,()=>assert.fail('Moved aliases must not grant primary access'));
  assert.equal(moved.code,409);
  await client.query('UPDATE professional_employees SET city_id=1 WHERE id=$1',[emptyId]);
  assert.throws(()=>identity.withAttendanceIdentity('UPDATE professional_attendance SET punch_in=NOW()'),/read-only/);
  // Exercise the real block reads together with both actual report controllers.
  // The enclosing test already owns a transaction; initialize only this fixture's
  // schema directly so no lazy initializer can commit that transaction.
  await client.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261021_professional_attendance_blocks.sql'),'utf8'));
  const blockReads=load('../utils/professionalAttendanceBlock.js',{
    fs,path,'../config/db':pool,'./professionalAttendanceIdentity':identity,
  });
  const access={...blockReads,ensureAttendanceBlockSchema:async()=>{},
    withAttendanceBlocks:rows=>blockReads.readAttendanceBlocks(rows,pool)};
  const reportsWithBlocks=load('../controllers/professionalReportsController.js',{
    ...reportDependencies,'../utils/professionalAccess':require('../utils/professionalAccess'),
    '../utils/professionalAttendanceBlock':access,
  });
  const appWithBlocks=load('../controllers/professionalAttendanceController.js',{
    '../config/db':pool,'../utils/professionalAttendanceIdentity':identity,'../utils/professionalAttendanceBlock':access,
    '../utils/professionalPunchCutoff':{ensurePunchCutoffSchema:async()=>{},loadPunchApprovals:async()=>new Map(),approvalProgress:()=>null},
    '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
    '../utils/logger':{error:console.error},'../utils/faceService':{},'../config/awsConfig':{},
    '../utils/s3SelfPunch':{},'../utils/cityTrafficCost':{},'./professionalGeofenceController':{},'./consentController':{},
  });
  const beforeBlock=(await client.query('SELECT * FROM professional_attendance ORDER BY id')).rows;
  await client.query(`INSERT INTO professional_attendance_blocks(professional_id,is_blocked,reason)
    SELECT unnest($1::uuid[]),TRUE,'Verified block fixture'`,[profileIds]);
  const blockedMonthly=response();
  await appWithBlocks.getMonthlyAttendance({professional:{professional_id:primaryId},query:{month:'2026-09'}},blockedMonthly);
  assert.equal(blockedMonthly.code,200);assert.equal(blockedMonthly.body.attendance_access.is_attendance_blocked,true);
  assert.deepEqual(JSON.parse(JSON.stringify(blockedMonthly.body.summary)),JSON.parse(JSON.stringify(appResult.body.summary)),'Blocking preserves actual monthly present, half-day, absent and payable totals');
  const blockedRange=await run(reportsWithBlocks,'getDateRangeAttendanceSummary',{start_date:'2026-09-01',end_date:'2026-09-30',professional_id:primaryId});
  assert.equal(blockedRange.data[0].is_attendance_blocked,true);
  assert.equal(blockedRange.data[0].attendance_count,29);assert.equal(blockedRange.data[0].payable_days,29);assert.equal(blockedRange.data[0].absent_days,1);
  const blockedDaily=await run(reportsWithBlocks,'getAttendanceList',{date:'2026-09-01',professional_id:primaryId});
  assert.equal(blockedDaily.data[0].is_attendance_blocked,true);assert.ok(blockedDaily.data[0].punch_in);
  const blockedDetails=await run(reportsWithBlocks,'getDateRangeAttendanceDetails',{start_date:'2026-09-01',end_date:'2026-09-30',professional_id:primaryId});
  assert.equal(blockedDetails.data.is_attendance_blocked,true);assert.equal(blockedDetails.data.attendance_days,29);
  const unrelatedAfterBlock=await run(reportsWithBlocks,'getDateRangeAttendanceSummary',{start_date:'2026-09-01',end_date:'2026-09-30',professional_id:stranger});
  assert.equal(unrelatedAfterBlock.data[0].is_attendance_blocked,undefined);assert.equal(unrelatedAfterBlock.data[0].attendance_count,1);
  await client.query('UPDATE professional_attendance_blocks SET is_blocked=FALSE WHERE professional_id=ANY($1::uuid[])',[profileIds]);
  assert.deepEqual((await client.query('SELECT * FROM professional_attendance ORDER BY id')).rows,beforeBlock,'Block/unblock and reports leave every stored attendance row unchanged');
  console.log('PASS: actual blocked daily/range/detail badges, Manisha monthly remains 28 present / 1 half-day / 29 payable, and unrelated employees and all stored attendance stay unchanged.');
  console.log('PASS: Manisha 28 present / 1 half-day / 29 payable, complete 29-date website history, all unlinked rows unchanged, aliases/search/exports source, other months, permissions, preserved records, current open punches, duplicate prevention and conflict/scope guards.');
};
