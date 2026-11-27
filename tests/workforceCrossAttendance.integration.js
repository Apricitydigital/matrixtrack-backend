// Disposable PostgreSQL only: no application environment or live database.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
test('cross-system transfers preserve original attendance, evidence and recovery; separate codes retain both histories',async()=>{
 const db=new PGlite(),routes=[],middleware=[];
 const pool={query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(r=>r.at(-1)),connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};
 const router={use:fn=>middleware.push(fn)};
 for(const verb of ['get','post','patch','delete'])router[verb]=(route,...handlers)=>routes.push({verb,route,handlers});
 const mocks={express:{Router:()=>router},'../config/db':pool,'../middleware/authMiddleware':(req,res,next)=>next(),
  '../middleware/cityScope':{attachCityScope:(req,res,next)=>next()},'../middleware/permissionMiddleware':{authorize:()=>((req,res,next)=>next()),getPermissionCityFilter:()=>[1]},
  '../utils/userKothiAccess':{fetchUserKothiAccess:async()=>({ids:[10]})},'../utils/employeeAliases':{ensureMergeSchema:async()=>{}}};
 const file=path.join(__dirname,'../routes/workforceReviewRoutes.js');
 vm.runInNewContext('(function(require,module){'+fs.readFileSync(file,'utf8')+'})',{console,process})(name=>mocks[name]||require(require.resolve(name,{paths:[path.dirname(file)]})),{exports:{}});
 async function call(route,{verb='post',kind='self_attendance',id=pro,body={},user=1,mergeId}={}){
  const req={user:{user_id:user},params:{kind,id,mergeId},body,query:{}},res={code:200,status(c){this.code=c;return this;},json(data){this.data=data;return this;}};
  for(const fn of [...middleware,...routes.find(r=>r.verb===verb&&r.route===route).handlers]){let next=false;await fn(req,res,()=>next=true);if(!next)break;}return res;
 }
 const pro='11111111-1111-4111-8111-111111111111';
 try{
  await db.exec(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,email TEXT,role TEXT,permissions JSONB,is_deleted BOOLEAN DEFAULT false);
   INSERT INTO users VALUES(1,'Owner','owner@example.test','super_admin',NULL,false),(2,'HR','hr@apricitydigital.in','admin','{}',false),(3,'Other admin','other@example.test','admin','{}',false);
   CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT); INSERT INTO cities VALUES(1,'One'),(2,'Two');
   CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(1,1),(2,2);
   CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,ward_name TEXT,sector_id INT);INSERT INTO wards VALUES(10,1,'Site',100),(20,2,'Other',200);
   CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,ward_id INT,face_id TEXT,face_embedding TEXT,is_deleted BOOLEAN DEFAULT false,aadhar_number TEXT);
   CREATE TABLE self_attendance_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,city_id INT,kothi_id INT,is_active BOOLEAN,selfie_url TEXT,aadhar_number TEXT,email TEXT);
   CREATE TABLE attendance(attendance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),emp_id INT REFERENCES employee,date DATE,ward_id INT,
    punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,mid_shift_punch_in_time TIMESTAMP,leave_type TEXT,punch_in_image TEXT,punch_out_image TEXT,latitude_in FLOAT,longitude_in FLOAT,UNIQUE(emp_id,date));
   CREATE TABLE self_attendance_records(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),self_attendance_id UUID REFERENCES self_attendance_employees,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,
    ward_id INT,zone_id INT,city_id INT,kothi_id INT,punch_in_photo_url TEXT,punch_out_photo_url TEXT,punch_in_latitude FLOAT,punch_in_longitude FLOAT,punch_approval_status TEXT DEFAULT 'accepted',UNIQUE(self_attendance_id,date));
   CREATE TABLE self_attendance_leave_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),self_attendance_id UUID REFERENCES self_attendance_employees,requested_date DATE,leave_type TEXT,status TEXT,reason TEXT);
   CREATE TABLE evidence(id SERIAL PRIMARY KEY,attendance_id UUID REFERENCES attendance,note TEXT);
   CREATE TABLE review_activity(id SERIAL PRIMARY KEY,actor_id UUID REFERENCES self_attendance_employees,note TEXT);
   CREATE TABLE self_punch_requests(id UUID PRIMARY KEY,emp_code TEXT,status TEXT);
   INSERT INTO employee VALUES(1,'Same person','DUP','9999999999',10,'face','embedding',false,'123456789012'),(2,'Other','TAKEN','8888888888',20,NULL,NULL,false,NULL);
   INSERT INTO self_attendance_employees VALUES('${pro}','Same person','DUP','9999999999',1,10,true,'face','123456789012','main@example.test');
   INSERT INTO self_punch_requests VALUES('${pro}','DUP','approved'),('22222222-2222-4222-8222-222222222222','RESERVED','pending');
   ALTER TABLE employee ADD COLUMN self_attendance_enabled BOOLEAN DEFAULT true;
   ALTER TABLE self_attendance_employees ADD COLUMN employee_id INT REFERENCES employee;
   INSERT INTO attendance(emp_id,date,ward_id,punch_in_time,punch_out_time,mid_shift_punch_in_time,punch_in_image,latitude_in) VALUES
    (1,'2026-11-01',10,'2026-11-01 09:00','2026-11-01 18:00','2026-11-01 12:00','original-photo',22.7),
    (1,'2026-11-02',10,'2026-11-02 09:00',NULL,NULL,'second-photo',22.8);
   INSERT INTO attendance(emp_id,date,ward_id,leave_type) VALUES(1,'2026-11-03',10,'CASUAL');
   INSERT INTO evidence(attendance_id,note) SELECT attendance_id,'original evidence' FROM attendance;
   INSERT INTO self_attendance_records(self_attendance_id,date,punch_in,punch_out,ward_id,zone_id,city_id,kothi_id) VALUES
    ('${pro}','2026-11-02','2026-11-02T04:00:00Z','2026-11-02T12:00:00Z',100,1,1,10);`);
  await db.query("INSERT INTO self_attendance_leave_requests(self_attendance_id,requested_date,leave_type,status) VALUES($1,'2026-11-04','CASUAL','approved')",[pro]);
  for(const migration of ['20261021_workforce_review.sql','20261023_non_duplicate_pairs.sql','20261021_workforce_merge.sql','20261022_workforce_merge_recovery.sql','20261126_cross_attendance_merge.sql'])
   await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',migration),'utf8'));
  await require('../utils/workforceMergeSchema').refreshMergeTriggers(pool);
  const originalRegular=(await db.query('SELECT to_jsonb(t) AS row FROM attendance t ORDER BY date')).rows.map(r=>r.row);
  const originalSelf=(await db.query('SELECT to_jsonb(t) AS row FROM self_attendance_records t')).rows.map(r=>r.row);
  const body={sources:[{kind:'regular',id:'1'}]};
  assert.equal((await call('/:kind/:id/merge-preview',{body,user:3})).code,403);
  assert.equal((await call('/:kind/:id/merge-preview',{body:{sources:[{kind:'regular',id:'2'}]},user:2})).code,404,'HR cannot transfer outside its city access');
  await db.query("UPDATE employee SET aadhar_number='234567890123' WHERE emp_id=1");
  assert.equal((await call('/:kind/:id/merge-preview',{body})).code,409,'cross-system identities require the same Aadhaar');
  await db.query("UPDATE employee SET aadhar_number='123456789012' WHERE emp_id=1");
  await db.query('UPDATE self_attendance_employees SET employee_id=1 WHERE id=$1',[pro]);
  const masterLinked=await call('/:kind/:id/merge-preview',{body});
  assert.equal(masterLinked.code,409);assert.match(masterLinked.data.message,/dependency in the destination/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM self_attendance_employees')).rows[0].n,1,'a linked main account can never be removed as a source dependency');
  await db.query('UPDATE self_attendance_employees SET employee_id=NULL WHERE id=$1',[pro]);
  await db.query('INSERT INTO review_activity(actor_id,note) VALUES($1,$2)',[pro,'Another employee approval']);
  const blockedActor=await call('/:kind/:id/merge-preview',{kind:'regular',id:'1',body:{sources:[{kind:'self_attendance',id:pro}]}});
  assert.equal(blockedActor.code,409);assert.match(blockedActor.data.message,/reviewer or supervisor activity/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM review_activity')).rows[0].n,1,'other employee activity is never deleted');
  await db.exec('DELETE FROM review_activity');
  let r=await call('/:kind/:id/merge-preview',{body,user:2});assert.equal(r.code,409,JSON.stringify(r.data));assert.equal(r.data.attendanceConflicts.length,1);
  const selected=r.data.attendanceConflicts[0].records.find(row=>row.id.startsWith('regular:')).id;
  const {contractValue}=require('../utils/selfAttendanceNaming');
  assert.equal(contractValue({otherKind:'professional'}).otherKind,'self_attendance','separation accepts the installed frontend attendance naming');
  const selfToken=r.data.attendanceConflicts[0].records.find(row=>row.id.startsWith('self:')).id;
  assert.equal(contractValue({id:selfToken},'legacy').id,selfToken,'conflict selections remain stable for installed clients');
  body.attendanceResolutions={'2026-11-02':selected};
  r=await call('/:kind/:id/merge-preview',{body,user:2});assert.equal(r.code,200,JSON.stringify(r.data));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,3,'preview rolls back migration');
  const confirmation={...body,confirmation:pro,identityConfirmed:true,reason:'Reviewed same employee',fingerprint:r.data.fingerprint};
  await db.query("UPDATE attendance SET punch_out_time='2026-11-01 18:01' WHERE date='2026-11-01'");
  assert.equal((await call('/:kind/:id/merge',{body:confirmation,user:2})).code,409,'stale source punches must invalidate preview');
  await db.query("UPDATE attendance SET punch_out_time='2026-11-01 18:00' WHERE date='2026-11-01'");
  r=await call('/:kind/:id/merge-preview',{body,user:2});confirmation.fingerprint=r.data.fingerprint;
  r=await call('/:kind/:id/merge',{body:confirmation,user:2});assert.equal(r.code,200,JSON.stringify(r.data));const mergeId=String(r.data.mergeId);
  const merged=(await db.query('SELECT * FROM self_attendance_records ORDER BY date')).rows;
  assert.equal(merged.length,2);assert.equal(merged[0].punch_in.toISOString(),'2026-11-01T03:30:00.000Z','regular wall-clock times convert as India time');
  assert.equal(merged[0].punch_in_photo_url,'original-photo');assert.equal(merged[0].punch_in_latitude,22.7);
  assert.equal(merged[0].ward_id,100);assert.equal(merged[0].kothi_id,10,'transfer preserves physical site separately from the retired Sector ID');
  assert.equal(merged[0].transfer_original.record.mid_shift_punch_in_time,originalRegular[0].mid_shift_punch_in_time);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM self_attendance_leave_requests WHERE requested_date='2026-11-03' AND status='approved'")).rows[0].n,1,'regular leave transfers as approved leave without inventing punches');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM employee WHERE emp_id=1')).rows[0].n,0);
  const archive=(await db.query("SELECT original_rows FROM workforce_transfer_archive WHERE merge_id=$1 AND source_table='attendance'",[mergeId])).rows[0].original_rows;
  assert.deepEqual(archive,originalRegular,'all original fields remain permanently archived');
  assert.equal((await db.query("SELECT jsonb_array_length(original_rows) AS n FROM workforce_transfer_archive WHERE merge_id=$1 AND source_table='evidence'",[mergeId])).rows[0].n,3);
  await assert.rejects(db.query("INSERT INTO attendance(emp_id,date) VALUES(1,'2026-11-03')"),/moved to another attendance system/,'delayed old-ID writes fail clearly');
  r=await call('/merges/:mergeId/attendance-originals',{verb:'get',mergeId,user:2});assert.equal(r.code,200);assert.equal(r.data.data.length,4);
  await db.query("UPDATE workforce_merge_audit SET restore_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[mergeId]);
  r=await call('/merges/:mergeId/attendance-originals',{verb:'get',mergeId,user:2});assert.equal(r.code,200);assert.equal(r.data.data.length,4,'originals remain accessible after recovery expires');
  await db.query("UPDATE workforce_merge_audit SET restore_until=clock_timestamp()+INTERVAL '1 hour' WHERE id=$1",[mergeId]);
  const undo=await call('/merges/:mergeId/revert-preview',{mergeId,user:2});assert.equal(undo.code,200,JSON.stringify(undo.data));
  r=await call('/merges/:mergeId/revert',{mergeId,user:2,body:{reason:'Restore exact originals',confirmation:pro,fingerprint:undo.data.fingerprint}});assert.equal(r.code,200,JSON.stringify(r.data));
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM attendance t ORDER BY date')).rows.map(r=>r.row),originalRegular);
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM self_attendance_records t')).rows.map(r=>r.row),originalSelf);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM evidence')).rows[0].n,3);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM self_attendance_leave_requests')).rows[0].n,1,'revert removes only the transferred leave and preserves existing leave');
  // Keep separate changes one code only, and only authorized scoped admins can do it.
  const separate={otherKind:'regular',otherId:'1',employeeCode:' taken '};
  assert.equal((await call('/:kind/:id/keep-separate',{body:separate,user:2})).code,409);
  assert.equal((await call('/:kind/:id/keep-separate',{body:{...separate,employeeCode:'reserved'},user:2})).code,409,'pending registrations reserve codes too');
  assert.equal((await call('/:kind/:id/keep-separate',{body:{...separate,employeeCode:'NEW'},user:3})).code,403);
  r=await call('/:kind/:id/keep-separate',{body:{...separate,employeeCode:'SELF-NEW'},user:2});assert.equal(r.code,200,JSON.stringify(r.data));
  assert.equal((await db.query('SELECT emp_code FROM self_attendance_employees')).rows[0].emp_code,'SELF-NEW');
  assert.equal((await db.query('SELECT emp_code FROM self_punch_requests WHERE id=$1',[pro])).rows[0].emp_code,'SELF-NEW','approved-request listing keeps the corrected code');
  assert.equal((await db.query('SELECT self_attendance_enabled FROM employee WHERE emp_id=1')).rows[0].self_attendance_enabled,false,'separate regular account is available in the supervisor roster');
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM attendance t ORDER BY date')).rows.map(r=>r.row),originalRegular);
  assert.deepEqual((await db.query('SELECT to_jsonb(t) AS row FROM self_attendance_records t')).rows.map(r=>r.row),originalSelf);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM workforce_non_duplicate_pairs')).rows[0].n,1);
  assert.equal((await call('/:kind/:id/merge-preview',{body})).code,409,'keeping separate prevents an accidental later merge');
  // Transfer the other direction after removing the intentional separation.
  await db.exec('DELETE FROM workforce_non_duplicate_pairs');
  await db.query('UPDATE employee SET self_attendance_enabled=true WHERE emp_id=1');
  let reverse={sources:[{kind:'self_attendance',id:pro}]};
  r=await call('/:kind/:id/merge-preview',{kind:'regular',id:'1',body:reverse});assert.equal(r.code,409);
  reverse.attendanceResolutions={'2026-11-02':r.data.attendanceConflicts[0].records.find(row=>row.id.startsWith('self:')).id};
  r=await call('/:kind/:id/merge-preview',{kind:'regular',id:'1',body:reverse});assert.equal(r.code,200,JSON.stringify(r.data));
  r=await call('/:kind/:id/merge',{kind:'regular',id:'1',body:{...reverse,confirmation:'1',identityConfirmed:true,reason:'Keep supervisor system',fingerprint:r.data.fingerprint}});assert.equal(r.code,200,JSON.stringify(r.data));
  const final=(await db.query("SELECT to_jsonb(t) AS row FROM attendance t WHERE date='2026-11-02'")).rows[0].row;
  assert.equal(final.punch_in_time,'2026-11-02T09:30:00');assert.equal(final.punch_out_time,'2026-11-02T17:30:00');assert.equal(final.transfer_original.kind,'self_attendance');
  assert.equal(final.ward_id,10,'regular reports use the physical Ward, not the Self Attendance Sector ID');
  const transferredLeave=(await db.query("SELECT * FROM attendance WHERE date='2026-11-04'")).rows[0];
  assert.equal(transferredLeave.leave_type,'CASUAL');assert.equal(transferredLeave.punch_in_time,null);assert.equal(transferredLeave.ward_id,10);
  assert.equal((await db.query('SELECT self_attendance_enabled FROM employee WHERE emp_id=1')).rows[0].self_attendance_enabled,false,'Supervisor destination enables the regular attendance mode');
  const filter=await require('../utils/selfAttendanceRequestFilters').buildScopedSelfAttendanceRequestFilters({},[],{client:pool});
  assert.equal((await db.query("SELECT count(*)::int AS n FROM self_punch_requests spr WHERE spr.status='approved' "+filter)).rows[0].n,0,'retired Self Attendance requests disappear from lists, counts and exports');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM self_punch_requests WHERE id=$1',[pro])).rows[0].n,1,'registration audit stays intact');
 }finally{await db.close();}
});
