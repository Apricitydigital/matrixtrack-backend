// Disposable PostgreSQL regression tests: synthetic employee, no .env/AWS/live DB.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),reqBackend=createRequire(path.join(root,'package.json'));
const {PGlite}=reqBackend('@electric-sql/pglite');
const {normalizeReport}=reqBackend('./utils/combinedAttendance');
const pro='e0000000-0000-4000-8000-000000000001',manager='e0000000-0000-4000-8000-000000000009';
const evidence=[];
function record(name,details){evidence.push({name,...details});}
async function fixture(){
 const db=new PGlite(),routes=[],middleware=[];
 const pool={query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1)),connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};
 const router={use:fn=>middleware.push(fn)};
 for(const verb of ['get','post','patch','delete'])router[verb]=(route,...handlers)=>routes.push({verb,route,handlers});
 const mocks={express:{Router:()=>router},'../config/db':pool,'../middleware/authMiddleware':(q,s,n)=>n(),
  '../middleware/cityScope':{attachCityScope:(q,s,n)=>n()},'../middleware/permissionMiddleware':{authorize:()=>((q,s,n)=>n()),getPermissionCityFilter:()=>[1]},
  '../utils/userKothiAccess':{fetchUserKothiAccess:async()=>({ids:[10]})},'../utils/employeeAliases':{ensureMergeSchema:async()=>{}}};
 const file=path.join(root,'routes/workforceReviewRoutes.js');
 vm.runInNewContext('(function(require,module){'+fs.readFileSync(file,'utf8')+'})',{console,process})(name=>mocks[name]||reqBackend(requireResolve(name)),{exports:{}});
 function requireResolve(name){return require.resolve(name,{paths:[path.dirname(file)]});}
 async function call(route,{kind='self_attendance',id=pro,body={},mergeId,user=1,verb='post'}={}){
  const q={user:{user_id:user},params:{kind,id,mergeId},body,query:{}},s={code:200,status(c){this.code=c;return this;},json(data){this.data=data;return this;}};
  for(const fn of [...middleware,...routes.find(r=>r.route===route&&r.verb===verb).handlers]){let next=false;await fn(q,s,()=>next=true);if(!next)break;}return s;
 }
 await db.exec(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,email TEXT,role TEXT,permissions JSONB,is_deleted BOOLEAN DEFAULT false);
 INSERT INTO users VALUES(1,'Review Owner','review@example.test','super_admin',NULL,false),(2,'HR','hr@humanmatrix.co.in','admin','{}',false);
 CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);INSERT INTO cities VALUES(1,'Test City');
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT,zone_name TEXT);INSERT INTO zones VALUES(1,1,'Test Zone');
 CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,sector_id INT,ward_name TEXT);INSERT INTO wards VALUES(10,1,100,'Test Site');
 CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,ward_id INT,face_id TEXT,face_embedding TEXT,is_deleted BOOLEAN DEFAULT false,self_attendance_enabled BOOLEAN DEFAULT false,aadhar_number TEXT);
 INSERT INTO employee VALUES(101,'Synthetic Transfer Employee','TEST101','9000000101',10,'face','face',false,false,'123456789012');
 CREATE TABLE self_attendance_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,is_active BOOLEAN,selfie_url TEXT,aadhar_number TEXT,email TEXT,created_at TIMESTAMPTZ DEFAULT now());
 INSERT INTO self_attendance_employees(id,full_name,emp_code,mobile,city_id,zone_id,ward_id,kothi_id,is_active,selfie_url,aadhar_number,email) VALUES
 ('${pro}','Synthetic Transfer Employee','TEST101','9000000101',1,1,100,10,true,'main-face','123456789012','test@example.test'),
 ('${manager}','Test Supervisor','MANAGER9','9000000009',1,1,100,10,true,'manager-face',NULL,'manager@example.test');
 CREATE TABLE supervisor_attendance_captures(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),actor_id UUID REFERENCES self_attendance_employees,site_id INT,image_key TEXT,punch_type TEXT);
 CREATE TABLE attendance(attendance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),emp_id INT REFERENCES employee,date DATE,ward_id INT REFERENCES wards,
 punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,mid_shift_punch_in_time TIMESTAMPTZ,leave_type TEXT,punch_in_image TEXT,punch_out_image TEXT,
 latitude_in FLOAT,longitude_in FLOAT,supervisor_in_by UUID REFERENCES self_attendance_employees,supervisor_out_by UUID REFERENCES self_attendance_employees,
 supervisor_in_name TEXT,supervisor_out_name TEXT,supervisor_in_capture UUID REFERENCES supervisor_attendance_captures,supervisor_out_capture UUID REFERENCES supervisor_attendance_captures,
 UNIQUE(emp_id,date));
 CREATE TABLE self_attendance_records(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),self_attendance_id UUID NOT NULL REFERENCES self_attendance_employees,date DATE NOT NULL,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,
 ward_id INT NOT NULL,zone_id INT NOT NULL,city_id INT NOT NULL,kothi_id INT,punch_in_photo_url TEXT,punch_out_photo_url TEXT,punch_in_latitude FLOAT,punch_in_longitude FLOAT,
 punch_approval_status TEXT NOT NULL DEFAULT 'accepted',UNIQUE(self_attendance_id,date),CHECK(punch_out IS NULL OR punch_out>=punch_in));
 CREATE TABLE self_attendance_leave_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),self_attendance_id UUID REFERENCES self_attendance_employees,requested_date DATE,leave_type TEXT,status TEXT,reason TEXT);`);
 for(const migration of ['20261021_workforce_review.sql','20261023_non_duplicate_pairs.sql','20261021_workforce_merge.sql','20261022_workforce_merge_recovery.sql','20261126_cross_attendance_merge.sql'])
  await db.exec(fs.readFileSync(path.join(root,'db/migrations',migration),'utf8'));
 await reqBackend('./utils/workforceMergeSchema').refreshMergeTriggers(pool);
 async function transfer(options={}){
  const body=options.body||{sources:[{kind:'regular',id:'101'}]};
  const pv=await call('/:kind/:id/merge-preview',{...options,body});assert.equal(pv.code,200,JSON.stringify(pv.data));
  const result=await call('/:kind/:id/merge',{...options,body:{...body,identityConfirmed:true,reason:'Isolated review test transfer',confirmation:options.id||pro,fingerprint:pv.data.fingerprint}});
  assert.equal(result.code,200,JSON.stringify(result.data));return result.data;
 }
 function report(row){return normalizeReport([{employee_kind:'self_attendance',name:'Synthetic Transfer Employee',emp_id:'self_attendance:'+pro,source_employee_id:pro,
  entries:[{date:new Date(row.date).toISOString().slice(0,10),record:JSON.parse(JSON.stringify(row))}]}]).records[0];}
 return {db,pool,call,transfer,report};
}
test('CONTROL: real transfer API commits a synthetic Supervisor employee to Self and reverts all original rows',async()=>{
 const f=await fixture();try{
  await f.db.query("INSERT INTO attendance(emp_id,date,ward_id,punch_in_time,punch_out_time,punch_in_image) VALUES(101,'2026-11-24',10,'2026-11-24 09:00','2026-11-24 18:00','legacy-photo-key')");
  const before=(await f.db.query('SELECT to_jsonb(t) AS row FROM attendance t')).rows[0].row;
  const result=await f.transfer({user:2});const transferred=(await f.db.query('SELECT * FROM self_attendance_records')).rows[0];
  assert.equal(transferred.punch_in.toISOString(),'2026-11-24T03:30:00.000Z');assert.equal(transferred.punch_in_photo_url,'legacy-photo-key');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM employee WHERE emp_id=101')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT is_active FROM self_attendance_employees WHERE id=$1',[pro])).rows[0].is_active,true);
  const pv=await f.call('/merges/:mergeId/revert-preview',{mergeId:String(result.mergeId),user:2});assert.equal(pv.code,200,JSON.stringify(pv.data));
  const undo=await f.call('/merges/:mergeId/revert',{mergeId:String(result.mergeId),user:2,body:{confirmation:pro,reason:'Restore synthetic employee',fingerprint:pv.data.fingerprint}});assert.equal(undo.code,200,JSON.stringify(undo.data));
  assert.deepEqual((await f.db.query('SELECT to_jsonb(t) AS row FROM attendance t')).rows[0].row,before);
  record('control',{pass:true,employee:'Synthetic Transfer Employee',sourceId:101,targetId:pro,transferCommitted:true,rollbackRestoredExactRow:true});
 }finally{await f.db.close();}
});
test('actual Supervisor group-photo evidence stays visible in Self attendance after transfer',async()=>{
 const f=await fixture();try{
  const capture=(await f.db.query("INSERT INTO supervisor_attendance_captures(actor_id,site_id,image_key,punch_type) VALUES($1,10,'supervisor-attendance/private/group-in.jpg','in') RETURNING id",[manager])).rows[0].id;
  await f.db.query("INSERT INTO attendance(emp_id,date,ward_id,punch_in_time,punch_out_time,supervisor_in_by,supervisor_in_name,supervisor_in_capture,punch_in_image) VALUES(101,'2026-11-24',10,'2026-11-24 09:00','2026-11-24 18:00',$1,'Test Supervisor',$2,NULL)",[manager,capture]);
  await f.transfer();const row=(await f.db.query('SELECT * FROM self_attendance_records')).rows[0],shown=f.report(row);
  record('group-photo',{transferCommitted:true,sourcePhotoKey:'supervisor-attendance/private/group-in.jpg',newSelfPhoto:row.punch_in_photo_url,reportPhoto:shown.punch_in_image,
   reportSource:shown.attendance_source,reportActor:shown.punched_in_by,sourceCaptureStillStored:!!(await f.db.query('SELECT id FROM supervisor_attendance_captures WHERE id=$1',[capture])).rows.length});
  assert.equal(shown.punch_in_image,'supervisor-attendance/private/group-in.jpg','a real Supervisor photo must remain available in the normal Self attendance report');
  assert.equal(row.punch_in_photo_url,null,'Private group photos never enter employee/public punch-photo fields');
  assert.equal(shown.attendance_source,'supervisor');assert.equal(shown.punched_in_by,'Test Supervisor');
  await f.db.query('DELETE FROM supervisor_attendance_captures WHERE id=$1',[capture]);
  assert.equal(f.report(row).punch_in_image,'supervisor-attendance/private/group-in.jpg','Archived evidence survives retirement of the old capture metadata');
 }finally{await f.db.close();}
});
test('mid-shift-only worked attendance remains present after Supervisor to Self transfer',async()=>{
 const f=await fixture();try{
  await f.db.query("INSERT INTO attendance(emp_id,date,ward_id,mid_shift_punch_in_time,punch_out_time) VALUES(101,'2026-11-24',10,'2026-11-24T04:30:00Z','2026-11-24 18:00')");
  const before=(await f.db.query('SELECT count(*)::int AS n FROM attendance WHERE punch_in_time IS NOT NULL OR mid_shift_punch_in_time IS NOT NULL')).rows[0].n;
  await f.transfer();const after=(await f.db.query('SELECT count(*)::int AS n FROM self_attendance_records WHERE punch_in IS NOT NULL')).rows[0].n;
  const row=(await f.db.query('SELECT * FROM self_attendance_records')).rows[0];
  record('mid-shift',{transferCommitted:true,presentDaysBefore:before,presentDaysAfter:after,reportPunchIn:f.report(row).punch_in,reportMidShift:f.report(row).mid_shift_punch_in,archivedMidShift:row.transfer_original.record.mid_shift_punch_in_time});
  assert.equal(after,before,'the normal daily/monthly reports must preserve worked-day classification, or the transfer must stop');
  assert.equal(row.punch_in.toISOString(),'2026-11-24T04:30:00.000Z','The actual mid-shift instant is unchanged');
  assert.equal(f.report(row).punch_in,'10:00:00');assert.equal(f.report(row).mid_shift_punch_in,'10:00:00');
 }finally{await f.db.close();}
});
test('legacy Self attendance with no physical-site snapshot stops safely before changing history',async()=>{
 const f=await fixture();try{
  await f.db.query("INSERT INTO self_attendance_records(self_attendance_id,date,punch_in,punch_out,ward_id,zone_id,city_id,kothi_id) VALUES($1,'2026-11-24','2026-11-24T03:30:00Z','2026-11-24T12:30:00Z',100,1,1,NULL)",[pro]);
  const options={kind:'regular',id:'101',body:{sources:[{kind:'self_attendance',id:pro}]}};
  const result=await f.call('/:kind/:id/merge-preview',options);
  assert.equal(result.code,409);assert.match(result.data.message,/Physical site was not recorded/);
  const direct=await f.call('/:kind/:id/merge',{...options,body:{...options.body,identityConfirmed:true,reason:'Cannot bypass site review',confirmation:'101',fingerprint:'unreviewed'}});
  assert.equal(direct.code,409);assert.match(direct.data.message,/Physical site was not recorded/);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM self_attendance_records')).rows[0].n,1);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
  record('legacy-site',{transferCommitted:false,status:result.code,originalHistoryUnchanged:true,requiresHistoricalSiteReview:true});
 }finally{await f.db.close();}
});
test('merging inactive history must not silently reactivate its disabled password',async()=>{
 const f=await fixture();try{
  const bcrypt=reqBackend('bcryptjs'),source='e0000000-0000-4000-8000-000000000002';
  await f.db.exec('ALTER TABLE self_attendance_employees ADD COLUMN password_hash TEXT,ADD COLUMN face_locked BOOLEAN DEFAULT false');
  await f.db.query('UPDATE self_attendance_employees SET password_hash=$1 WHERE id=$2',[await bcrypt.hash('working-main-fixture',4),pro]);
  await f.db.query(`INSERT INTO self_attendance_employees(id,full_name,emp_code,mobile,city_id,zone_id,ward_id,kothi_id,is_active,selfie_url,aadhar_number,email,password_hash)
   VALUES($1,'Synthetic Transfer Employee','OLD101','9000000202',1,1,100,10,false,'old-face','123456789012','disabled@example.test',$2)`,[source,await bcrypt.hash('disabled-fixture-password',4)]);
  const mod={exports:{}},authFile=path.join(root,'controllers/selfAttendanceAuthController.js');
  const mocks={'../config/db':f.pool,'../utils/logger':{info(){},error(){}},'../utils/employeeAliases':{hasLoginAliases:async()=>true},'../utils/selfAttendanceMergeLogin':reqBackend('./utils/selfAttendanceMergeLogin')};
  vm.runInNewContext(fs.readFileSync(authFile,'utf8'),{module:mod,console,process:{env:{JWT_SECRET:'isolated-review-jwt-secret'}},require:name=>mocks[name]||reqBackend(name)});
  async function login(){const res={code:200,status(c){this.code=c;return this;},json(body){this.body=body;return this;}};await mod.exports.login({body:{email:'disabled@example.test',password:'disabled-fixture-password'}},res);return res;}
  const before=await login();assert.equal(before.code,403);
  await f.transfer({body:{sourceIds:[source]}});const after=await login();
  record('inactive-password',{loginBeforeMerge:before.code,loginAfterMerge:after.code,returnedActiveProfile:after.body?.self_attendance?.id||null});
  assert.notEqual(after.code,200,'retaining inactive attendance must not revive a password belonging to a deactivated account');
 }finally{await f.db.close();}
});
