// Runs against an isolated in-memory PostgreSQL database; never touches live data.
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { PGlite } = require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
async function main() {
  const db = new PGlite();
  const client = {release(){},query:async(sql,params=[])=>params.length ? db.query(sql,params) : (await db.exec(sql)).at(-1) || {rows:[]}};
  const person='00000000-0000-4000-8000-000000000001', pm='00000000-0000-4000-8000-000000000002', ho='00000000-0000-4000-8000-000000000003', country='00000000-0000-4000-8000-000000000004', outside='00000000-0000-4000-8000-000000000005';
  const load=(file,deps)=>{ const ref={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8'),{require:name=>{if(!(name in deps)) throw new Error('Unexpected dependency '+name);return deps[name];},module:ref,console,Set,Array,Number,String,Date,Promise,Object,Buffer,Math,JSON,parseFloat,process:{env:{PROFESSIONAL_LIVENESS_ENABLED:'false'}},__dirname:path.join(__dirname,'../utils')});return ref.exports;};
  try {
    await client.query(`CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,kothi_id INT,city_id INT,is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,email TEXT,role TEXT,permissions JSONB,is_deleted BOOLEAN DEFAULT FALSE);
      CREATE TABLE permissions(id SERIAL PRIMARY KEY,module TEXT,action TEXT);
      INSERT INTO users VALUES(1,'Superadmin','admin@gmail.com','admin','{}',FALSE),(2,'Admin','ordinary@example.com','admin','{}',FALSE),(3,'Super role','role@example.com','super_admin','{}',FALSE),(4,'Deleted','deleted@example.com','super_admin','{}',TRUE);
      CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT); CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);
      CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);
      INSERT INTO department VALUES(1,'Professional');
      CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT,department_id INT DEFAULT 1);
      CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);
      CREATE TABLE professional_site_access(professional_id UUID,kothi_id INT);
      CREATE TABLE professional_attendance(id SERIAL PRIMARY KEY,professional_id UUID,date DATE,punch_in TIMESTAMPTZ NOT NULL,punch_out TIMESTAMPTZ,UNIQUE(professional_id,date));
      CREATE TABLE professional_notifications(professional_id UUID,type TEXT,title TEXT,message TEXT,metadata JSONB);
      INSERT INTO wards VALUES(1,'Solaris'),(2,'Outside');INSERT INTO cities VALUES(1,'Indore');
      INSERT INTO designation(designation_id,designation_name) VALUES(1,'Project Head / Site Head'),(2,'HO Coordinator'),(3,'Head of Department');
      INSERT INTO professional_employees VALUES('${person}','Ashu','E1',1,1,TRUE),('${pm}','PM','E2',1,1,TRUE),('${ho}','HO','E3',1,1,TRUE),('${country}','Country','E4',1,1,TRUE),('${outside}','Outside','E5',2,1,TRUE);
      INSERT INTO professional_designation_assignments VALUES('${pm}',1),('${ho}',2),('${country}',3);
      INSERT INTO professional_site_access VALUES('${pm}',1),('${ho}',1),('${country}',1);`);
    const sql=fs.readFileSync(path.join(__dirname,'../db/migrations/20261014_professional_punch_cutoff.sql'),'utf8');
    await client.query(sql);await client.query(sql);
    const pool={query:client.query,connect:async()=>client};
    const utility=load('../utils/professionalPunchCutoff.js',{'fs':fs,'path':path,'../config/db':pool});
    utility.ensurePunchCutoffSchema=async()=>{};
    assert.equal((await utility.getPunchSettings()).enabled,false,'restriction defaults OFF');
    const settingsRouter={routes:[],middleware:[],use(...h){this.middleware.push(...h);}};
    for(const method of ['get','patch']) settingsRouter[method]=(url,...handlers)=>settingsRouter.routes.push({method,url,handlers});
    load('../routes/professionalPunchSettingsRoutes.js',{'express':{Router:()=>settingsRouter},'../config/db':pool,'../middleware/authMiddleware':(req,res,next)=>next(),'../utils/professionalPunchCutoff':utility});
    const setting=async(method,user,body={})=>{
      // A forged super-admin token claim must not override the database role.
      const req={user:{user_id:user,role:'super_admin'},body};
      const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
      let proceed;
      for(const middleware of settingsRouter.middleware) {proceed=false;await middleware(req,res,()=>{proceed=true;});if(!proceed) return res;}
      for(const handler of settingsRouter.routes.find(r=>r.method===method).handlers) await handler(req,res);
      return res;
    };
    assert.equal((await setting('patch',2,{enabled:true})).code,403);
    assert.equal((await setting('patch',4,{enabled:true})).code,403);
    assert.equal((await setting('patch',1,{enabled:'true'})).code,400);
    assert.equal((await setting('patch',1,{enabled:true})).body.data.enabled,true);
    await client.query(sql);assert.equal((await utility.getPunchSettings()).enabled,true,'Schema initialization preserves the saved switch');
    assert.equal((await setting('get',3)).body.data.enabled,true,'Superadmin role has access');
    assert.equal((await client.query('SELECT actor_user_id FROM professional_punch_setting_history')).rows[0].actor_user_id,1);
    const router={routes:[],middleware:[],use(...h){this.middleware.push(...h);}};
    for(const method of ['get','put','post']) router[method]=(url,...handlers)=>router.routes.push({method,url,handlers});
    load('../routes/professionalPunchCutoffRoutes.js',{'express':{Router:()=>router},'../config/db':pool,'../middleware/professionalAuth':(req,res,next)=>next(),
      '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},'../utils/professionalPunchCutoff':utility});
    async function run(method,url,actor,options={}) {
      const req={professional:{professional_id:actor},params:{employee:person,date:'2026-10-14'},body:{},...options};
      const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
      let proceed=true;
      for(const middleware of router.middleware) {proceed=false;await middleware(req,res,()=>{proceed=true;});if(!proceed) return res;}
      for(const handler of router.routes.find(r=>r.method===method && r.url===url).handlers) await handler(req,res);
      return res;
    }
    assert.equal((await run('put','/employees/:employee',country,{body:{cutoff_time:'09:30'}})).code,403);
    assert.equal((await run('put','/employees/:employee',pm,{params:{employee:outside},body:{cutoff_time:'09:30'}})).code,403);
    assert.equal((await run('put','/employees/:employee',pm,{body:{cutoff_time:'25:00'}})).code,400);
    assert.equal((await run('put','/employees/:employee',pm,{body:{cutoff_time:'09:30'}})).code,200);
    assert.equal((await run('put','/employees/:employee',ho,{body:{cutoff_time:'09:45'}})).code,200);
    const history=(await run('get','/history',country)).body.data;
    assert.equal(history.length,2);assert.equal(history[0].old_time,'09:30:00');assert.equal(history[0].actor_id,ho);
    // Execute the actual controller expression with fixed arrival timestamps.
    const source=fs.readFileSync(path.join(__dirname,'../controllers/professionalAttendanceController.js'),'utf8');
    const lateExpression=source.match(/s\.enabled AND ([\s\S]*?) AS is_late/)[1].replaceAll('transaction_timestamp()', '$1::timestamptz');
    const isLate=async(arrival,cutoff,enabled=true)=>(await client.query(`SELECT s.enabled AND ${lateExpression} AS late FROM (SELECT $2::time AS cutoff_time) t CROSS JOIN (SELECT $3::boolean AS enabled) s`,[arrival,cutoff,enabled])).rows[0].late;
    for(const time of ['09:29:59','09:30:00','09:44:59','09:45:00']) assert.equal(await isLate(`2026-10-15T${time}+05:30`,'09:30'),false);
    assert.equal(await isLate('2026-10-15T09:45:01+05:30','09:30'),true);
    assert.equal(await isLate('2026-10-15T04:15:00Z','09:30'),false,'Grace boundary uses IST');
    assert.equal(await isLate('2026-10-15T04:15:01Z','09:30'),true);
    assert.equal(await isLate('2026-10-15T11:00:00+05:30','09:30',false),false);
    assert.equal(await isLate('2026-10-15T11:00:00+05:30',null),null,'No assigned time retains normal punch-in');
    assert.equal(await isLate('2026-10-15T23:59:59+05:30','23:50'),false,'Grace must not wrap to an early same-day time');
    await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,attempted_punch_in,punch_approval_status,punch_cutoff)
      VALUES($1,'2026-10-14',NULL,'2026-10-14T10:00:00+05:30','pending_pm','09:45')`,[person]);
    await utility.notifyStage(client,person,'2026-10-14','pending_pm');
    assert.equal((await client.query('SELECT professional_id FROM professional_notifications')).rows[0].professional_id,pm);
    assert.equal((await run('get','/capabilities',pm)).body.pending_count,1);
    assert.equal((await run('get','/capabilities',ho)).body.pending_count,0);
    assert.equal((await run('post','/requests/:employee/:date',ho,{body:{decision:'allow'}})).code,403,'HO cannot skip PM');
    assert.equal((await run('post','/requests/:employee/:date',pm,{body:{decision:'allow',note:'   '}})).code,400,'PM approval must include a reason');
    assert.equal((await client.query('SELECT punch_approval_status FROM professional_attendance')).rows[0].punch_approval_status,'pending_pm');
    assert.equal((await run('post','/requests/:employee/:date',pm,{body:{decision:'allow',note:'Verified'}})).body.status,'pending_ho');
    for(const reviewer of [ho,country]) {
      const request=(await run('get','/requests',reviewer)).body.data[0];assert.equal(request.pm_reason,'Verified');assert.equal(request.pm_reviewer_name,'PM');assert.ok(request.pm_reviewed_at);
      if(reviewer===country){assert.equal(request.can_review,false);assert.equal((await run('post','/requests/:employee/:date',country,{body:{decision:'allow',note:'Viewed'}})).code,403,'HOD remains view only');}
    }
    assert.equal((await client.query('SELECT punch_in FROM professional_attendance')).rows[0].punch_in,null);
    assert.equal((await run('get','/capabilities',ho)).body.pending_count,1);
    const myApprovalBucket=(await run('get','/requests',pm,{query:{bucket:'mine'}})).body;
    assert.equal(myApprovalBucket.counts.mine,1);assert.equal(myApprovalBucket.counts.pending_ho,0);assert.equal(myApprovalBucket.counts.pending,0);assert.equal(myApprovalBucket.counts.approved,0);
    assert.equal(myApprovalBucket.data[0].approved_by_me,true);assert.equal(myApprovalBucket.data[0].employee_request_count,1);
    assert.equal(myApprovalBucket.data[0].punch_approval_status,'pending_ho');
    assert.equal((await run('get','/requests',pm,{query:{bucket:'pending'}})).body.data.length,0,'PM-approved request leaves the PM pending queue');
    const hoQueue=(await run('get','/requests',ho,{query:{bucket:'pending'}})).body;
    assert.equal(hoQueue.counts.pending,1);assert.equal(hoQueue.counts.pending_ho,1);assert.equal(hoQueue.data[0].can_review,true);
    const hodQueue=(await run('get','/requests',country,{query:{bucket:'pending'}})).body;
    assert.equal(hodQueue.counts.pending,0);assert.equal(hodQueue.data.length,0,'HOD has no action on normal employee requests');

    assert.equal((await run('get','/requests',ho,{query:{bucket:'mine'}})).body.data.length,0);
    assert.equal((await run('get','/requests',country,{query:{bucket:'mine'}})).body.data.length,0);
    assert.equal((await run('get','/requests',pm,{query:{bucket:'approved'}})).body.data.length,0);
    assert.equal((await run('get','/requests',pm,{query:{bucket:'invalid'}})).code,400);
    assert.equal((await run('post','/requests/:employee/:date',ho,{body:{decision:'allow'}})).body.status,'accepted');
    const finalApproved=(await run('get','/requests',ho,{query:{bucket:'approved'}})).body;
    assert.equal(finalApproved.counts.pending,0);assert.equal(finalApproved.counts.mine,1);assert.equal(finalApproved.counts.approved,1);
    assert.equal(finalApproved.data[0].ho_reviewer_name,'HO');assert.ok(finalApproved.data[0].ho_reviewed_at);
    assert.equal((await run('get','/requests',pm,{query:{bucket:'pending'}})).body.data.length,0);
    assert.equal((await run('get','/requests',pm,{query:{bucket:'mine'}})).body.data.length,1);

    const accepted=(await client.query('SELECT punch_in,attempted_punch_in FROM professional_attendance')).rows[0];
    assert.equal(new Date(accepted.punch_in).getTime(),new Date(accepted.attempted_punch_in).getTime());
    assert.equal((await run('post','/requests/:employee/:date',ho,{body:{decision:'reject'}})).code,403,'Final state is immutable');
    for(const rejector of [pm,ho]) {
      await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,attempted_punch_in,punch_approval_status)
        VALUES($1,$2,NULL,'2026-10-15T10:00:00+05:30','pending_pm')`,[person,rejector===pm ? '2026-10-15' : '2026-10-16']);
      const params={employee:person,date:rejector===pm ? '2026-10-15' : '2026-10-16'};
      if(rejector===ho) await run('post','/requests/:employee/:date',pm,{params,body:{decision:'allow',note:'Verified arrival'}});
      assert.equal((await run('post','/requests/:employee/:date',rejector,{params,body:{decision:'reject',note:'Late'}})).body.status,'rejected');
    }
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_attendance WHERE punch_in IS NOT NULL')).rows[0].n,1,'Rejected attempts never count as attendance');
    const visible=(await run('get','/requests',country)).body.data;
    assert.equal(visible.filter(r=>r.punch_approval_status==='rejected').length,2);
    assert.ok(visible.every(r=>!r.can_review));
    assert.throws(()=>utility.nextDecision('pending_pm',{pm:true},'allow',pm,pm,null),/own/);
    assert.throws(()=>utility.nextDecision('pending_ho',{ho:true},'allow',ho,person,ho),/different/);
    // Exercise the real punch-in controller with PostgreSQL, stubbing only
    // external biometrics/storage and geofencing services.
    await client.query(`ALTER TABLE professional_employees ADD COLUMN selfie_url TEXT,ADD COLUMN mobile TEXT,ADD COLUMN email TEXT,ADD COLUMN zone_id INT,ADD COLUMN ward_id INT;
      ALTER TABLE professional_attendance ADD COLUMN ward_id INT,ADD COLUMN zone_id INT,ADD COLUMN city_id INT;
      CREATE TABLE professional_leave_requests(id SERIAL,professional_id UUID,requested_date DATE,status TEXT,leave_type TEXT,reason TEXT,requested_at TIMESTAMPTZ,reviewed_at TIMESTAMPTZ,review_note TEXT,reviewed_by INT);
      CREATE TABLE professional_holidays(id SERIAL,holiday_date DATE,holiday_name TEXT,description TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE FUNCTION professional_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS 'SELECT FALSE';
      DELETE FROM professional_attendance;
      DELETE FROM professional_punch_activity WHERE attendance_date IS NOT NULL;
      UPDATE professional_punch_cutoffs SET cutoff_time='00:00';`);
    let faceAllowed=true, geoAllowed=true, faceCalls=0;
    const controller=load('../controllers/professionalAttendanceController.js',{
      '../config/db':pool,'../utils/professionalPunchCutoff':utility,
      '../utils/logger':{info(){},warn(){},error:(label,e)=>console.error(label,e)},
      '../utils/faceService':{verifyFaceMatch:async()=>{faceCalls++;return {isMatch:faceAllowed};}},
      '../config/awsConfig':{},'../utils/s3SelfPunch':{getSignedS3Url:async v=>v,uploadToS3:async()=>null},
      '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
      '../utils/cityTrafficCost':{trackSuccessfulAttendanceEvent(){},sendTrackedRekognition:async()=>{}},
      './professionalGeofenceController':{validateProfessionalGeofenceAccess:async()=>({allowed:geoAllowed})},
      './consentController':{logUserConsent:async()=>{}},
    });
    const punch=async employee=>{
      const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
      await controller.punchIn({professional:{professional_id:employee,ward_id:1,zone_id:1,city_id:1},body:{selfie_base64:'eA==',latitude:22,longitude:75},headers:{}},res);
      return res;
    };
    geoAllowed=false;assert.equal((await punch(person)).code,403);assert.equal(faceCalls,0,'geofencing precedes biometrics');
    geoAllowed=true;faceAllowed=false;assert.equal((await punch(person)).code,403);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_attendance')).rows[0].n,0,'failed verification creates no request');
    faceAllowed=true;const late=await punch(person);
    assert.equal(late.code,200);assert.equal(late.body.status,'in-consideration');assert.equal(late.body.punch_in_time,null);
    assert.ok(late.body.attempted_punch_in);assert.equal((await punch(person)).code,409,'pending attempt cannot be resubmitted');
    const todayStatus=async()=>{
      const res={status(){return this;},json(body){this.body=body;return this;}};
      await controller.getTodayStatus({professional:{professional_id:person}},res);return res.body.data;
    };
    const pendingToday=await todayStatus();assert.equal(pendingToday.status,'in-consideration');assert.ok(pendingToday.attempted_punch_in);
    assert.equal(pendingToday.approval_progress.pm.status,'pending');assert.equal(pendingToday.approval_progress.ho.status,'waiting_for_pm');
    const beforeOutFaces=faceCalls;
    const outRes={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
    await controller.punchOut({professional:{professional_id:person},body:{selfie_base64:'eA=='},headers:{}},outRes);
    assert.equal(outRes.code,409);assert.equal(faceCalls,beforeOutFaces,'pending punch-out blocked before biometrics');
    const requestDate=(await client.query('SELECT date::text AS date FROM professional_attendance WHERE professional_id=$1',[person])).rows[0].date;
    await run('post','/requests/:employee/:date',pm,{params:{employee:person,date:requestDate},body:{decision:'reject'}});
    assert.equal((await todayStatus()).status,'punch-not-accepted');
    const rejectedToday=await todayStatus();assert.equal(rejectedToday.approval_progress.pm.status,'rejected');assert.equal(rejectedToday.approval_progress.pm.reviewer_name,'PM');assert.equal(rejectedToday.approval_progress.ho.status,'not_required');
    const normal=await punch(outside);assert.equal(normal.code,200);assert.equal(normal.body.status,'present');assert.ok(normal.body.punch_in_time,'no cutoff preserves normal attendance');
    // Recreate a pending request for the disable test; final decisions remain
    // immutable through the production API.
    await client.query('DELETE FROM professional_attendance WHERE professional_id=$1',[person]);
    await client.query('DELETE FROM professional_punch_activity WHERE professional_id=$1 AND attendance_date=$2',[person,requestDate]);
    await punch(person);
    await run('post','/requests/:employee/:date',pm,{params:{employee:person,date:requestDate},body:{decision:'allow',note:'Verified late arrival'}});
    const pmApproved=await todayStatus();assert.equal(pmApproved.approval_progress.pm.status,'approved');assert.equal(pmApproved.approval_progress.pm.reviewer_name,'PM');assert.equal(pmApproved.approval_progress.ho.status,'pending');assert.ok(pmApproved.approval_progress.pm.reviewed_at);
    const monthlyRes={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
    await controller.getMonthlyAttendance({professional:{professional_id:person},query:{month:requestDate.slice(0,7)}},monthlyRes);
    assert.equal(monthlyRes.code,200);
    const monthlyRecord=monthlyRes.body.data.find(r=>r.date===requestDate);
    assert.equal(monthlyRecord.is_late_punch,true);assert.equal(monthlyRes.body.summary.total_late_punch_in,1);
    assert.equal(monthlyRecord.approval_progress.pm.status,'approved');assert.equal(monthlyRecord.approval_progress.ho.status,'pending');assert.equal(monthlyRecord.approval_progress.pm.note,'Verified late arrival');
    assert.equal((await setting('patch',1,{enabled:false})).body.data.enabled,false);
    assert.equal((await todayStatus()).status,'in-consideration','Disable preserves existing pending requests');
    assert.equal((await todayStatus()).cutoff_enforcement_enabled,false);
    await client.query(`INSERT INTO professional_punch_cutoffs(professional_id,cutoff_time,updated_by) VALUES($1,'00:00',$2)`,[outside,pm]);
    await client.query('DELETE FROM professional_attendance WHERE professional_id=$1',[outside]);
    const notificationsBefore=(await client.query('SELECT COUNT(*)::int AS n FROM professional_notifications')).rows[0].n;
    const disabledPunch=await punch(outside);assert.equal(disabledPunch.body.status,'present');assert.ok(disabledPunch.body.punch_in_time);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_notifications')).rows[0].n,notificationsBefore,'Disabled mode creates no late approval notifications');
    await run('post','/requests/:employee/:date',ho,{params:{employee:person,date:requestDate},body:{decision:'allow'}});
    const hoApproved=await todayStatus();assert.equal(hoApproved.approval_progress.pm.status,'approved');assert.equal(hoApproved.approval_progress.ho.status,'approved');assert.equal(hoApproved.approval_progress.ho.reviewer_name,'HO');
    assert.equal(hoApproved.is_late_punch,true,'Late marker remains after final approval');
    const acceptedMonthly={status(){return this;},json(body){this.body=body;return this;}};
    await controller.getMonthlyAttendance({professional:{professional_id:person},query:{month:requestDate.slice(0,7)}},acceptedMonthly);
    assert.equal(acceptedMonthly.body.data.find(r=>r.date===requestDate).is_late_punch,true);assert.equal(acceptedMonthly.body.summary.total_late_punch_in,1);
    await setting('patch',1,{enabled:true});
    await client.query('DELETE FROM professional_attendance WHERE professional_id=$1',[outside]);
    assert.equal((await punch(outside)).body.status,'in-consideration','Re-enabling applies the previously saved cutoff');
    console.log('PASS: cutoff validation/audit, scope, IST boundary, stage notifications, PM → HO approvals, original time, rejection at both stages, Head of Department visibility and attendance exclusion.');
    console.log('PASS: actual punch-in controller, geofencing/face guards, pending late submission, duplicate prevention and employees without cutoffs.');
    console.log('PASS: Superadmin-only audited switch, disabled cutoff bypass, pending preservation, and employee PM/HO approval progress.');
    await require('./professionalPunchBulk.integration')(client,pool,utility);
    const mobileHistory=(await run('get','/history',country)).body.data;
    assert.ok(mobileHistory.some(h=>h.actor_name==='Admin' && h.actor_user_id===2),'PM/HO/Head of Department history includes scoped admin imports');
    assert.equal((await run('put','/employees/:employee',pm,{body:{cutoff_time:'08:45'}})).code,200);
    const professionalEdit=(await client.query('SELECT updated_by,updated_by_user FROM professional_punch_cutoffs WHERE professional_id=$1',[person])).rows[0];
    assert.equal(professionalEdit.updated_by,pm);assert.equal(professionalEdit.updated_by_user,null,'Professional edits replace the current admin actor');
    // Leave status must survive an empty attendance row as well as missing rows.
    await client.query(`INSERT INTO professional_leave_requests(professional_id,requested_date,status,leave_type)
      VALUES($1,'2001-01-02','pending','CASUAL'),($1,'2001-01-03','approved','CASUAL'),($1,'2001-01-04','rejected','CASUAL');
      `,[person]);
    await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES($1,'2001-01-03',NULL)`,[person]);
    const leaveReport={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
    await controller.getMonthlyAttendance({professional:{professional_id:person},query:{month:'2001-01'}},leaveReport);
    assert.equal(leaveReport.code,200);
    for(const [date,status] of [['2001-01-02','leave-pending'],['2001-01-03','leave-approved'],['2001-01-04','leave-rejected']]) {
      assert.equal(leaveReport.body.data.find(r=>r.date===date).status,status);
    }
    assert.equal(leaveReport.body.summary.total_leave_approved,1);
    assert.equal(leaveReport.body.summary.total_leave_pending,1);
    assert.equal(leaveReport.body.summary.total_leave_rejected,1);
    console.log('PASS: employee monthly attendance preserves approved, pending and rejected leave, including empty attendance rows.');
    await client.query(`INSERT INTO professional_holidays(holiday_date,holiday_name,description,city_id,kothi_id)
      VALUES($1,'Site Company Holiday','Paid site holiday',1,1),('2001-01-03','Overlapping holiday',NULL,1,1),('2001-01-05','Company Holiday',NULL,1,1)`,[requestDate]);
    await client.query('DELETE FROM professional_attendance WHERE professional_id=$1 AND date=$2',[person,requestDate]);
    const holidayToday=await todayStatus();assert.equal(holidayToday.status,'holiday');assert.equal(holidayToday.is_holiday,true);assert.equal(holidayToday.holiday.holiday_name,'Site Company Holiday');
    const otherSite={status(){return this;},json(body){this.body=body;return this;}};
    await controller.getTodayStatus({professional:{professional_id:outside}},otherSite);
    assert.equal(otherSite.body.data.is_holiday,false,'A holiday must not affect employees in other sites');
    const holidayMonthly={status(){return this;},json(body){this.body=body;return this;}};
    await controller.getMonthlyAttendance({professional:{professional_id:person},query:{month:'2001-01'}},holidayMonthly);
    assert.equal(holidayMonthly.body.data.find(r=>r.date==='2001-01-05').status,'holiday');
    assert.equal(holidayMonthly.body.summary.total_payable_days,2,'Approved leave plus overlapping holiday is counted once, plus the separate holiday');
    assert.equal(holidayMonthly.body.summary.total_holiday,2);
    console.log('PASS: employee Home/calendar holiday data is site-specific and company holidays add payable days without overlap.');
    await client.query('UPDATE professional_punch_settings SET enabled=TRUE');
    await client.query("INSERT INTO professional_punch_cutoffs(professional_id,cutoff_time,updated_by) VALUES($1,'00:00',$2) ON CONFLICT(professional_id) DO UPDATE SET cutoff_time='00:00'",[ho,pm]);
    const hoPunch=await punch(ho);assert.equal(hoPunch.code,200);assert.equal(hoPunch.body.status,'in-consideration');
    const hoDate=(await client.query('SELECT date::text AS date FROM professional_attendance WHERE professional_id=$1',[ho])).rows[0].date;
    assert.equal((await client.query('SELECT punch_approval_status FROM professional_attendance WHERE professional_id=$1',[ho])).rows[0].punch_approval_status,'pending_hod');
    const hoParams={employee:ho,date:hoDate};
    assert.equal((await run('post','/requests/:employee/:date',pm,{params:hoParams,body:{decision:'allow',note:'PM'}})).code,403);
    assert.equal((await run('post','/requests/:employee/:date',ho,{params:hoParams,body:{decision:'allow'}})).code,403);
    assert.equal((await run('get','/capabilities',country)).body.pending_count,1);
    const hodPending=(await run('get','/requests',country,{query:{bucket:'pending'}})).body;assert.equal(hodPending.counts.pending_hod,1);assert.equal(hodPending.data[0].can_review,true);
    assert.equal((await run('post','/requests/:employee/:date',country,{params:hoParams,body:{decision:'allow',note:'HOD verified'}})).body.status,'accepted');
    const hodMine=(await run('get','/requests',country,{query:{bucket:'mine'}})).body;assert.equal(hodMine.data[0].hod_reviewer_name,'Country');assert.equal(hodMine.data[0].hod_reason,'HOD verified');
    const hoStatus={status(){return this;},json(body){this.body=body;return this;}};await controller.getTodayStatus({professional:{professional_id:ho}},hoStatus);assert.equal(hoStatus.body.data.approval_progress.hod.status,'approved');assert.equal(hoStatus.body.data.status,'present');
    assert.equal((await run('put','/employees/:employee',country,{params:{employee:ho},body:{cutoff_time:'10:00'}})).code,403,'HOD approval access does not grant cutoff editing');
    await client.query("INSERT INTO professional_attendance(professional_id,date,attempted_punch_in,punch_approval_status) VALUES($1,'2001-02-01','2001-02-01T06:00:00Z','pending_pm')",[ho]);
    const hodPunchMigration=fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_hod_punch_approval.sql'),'utf8');await client.query(hodPunchMigration);await client.query(hodPunchMigration);
    const routeEvents=(await client.query("SELECT * FROM professional_punch_activity WHERE professional_id=$1 AND action='route_to_hod'",[ho])).rows;assert.equal(routeEvents.length,1);assert.equal(routeEvents[0].actor_id,null);
    assert.equal((await run('post','/requests/:employee/:date',country,{params:{employee:ho,date:'2001-02-01'},body:{decision:'reject',note:'Not accepted'}})).body.status,'rejected');
    console.log('PASS: HO late punch directly to HOD, self/PM denial, HOD queue/counts, approval audit and employee progress; no HOD cutoff editing.');

  } finally {await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
