// Isolated PostgreSQL fixture: never reads application .env or connects to live data.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const db=new PGlite();
const routes=[],middleware=[];
const router={use:fn=>middleware.push(fn)};
for(const verb of ['get','post','patch','delete'])router[verb]=(route,...handlers)=>routes.push({verb,route,handlers});
const pool={query:(sql,params)=>params ? db.query(sql,params) : db.exec(sql).then(results=>results.at(-1)),connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};
const mergeMigration=async()=>{
 await pool.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261021_workforce_merge.sql'),'utf8'));
 await pool.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261022_workforce_merge_recovery.sql'),'utf8'));
 await pool.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261022_merge_weeklyoff_recovery.sql'),'utf8'));
 // Explicit fixture deployment setup, separate from production's read-only gate.
 const {references,installAliasTriggers}=require('../utils/workforceMerge');
 for(const kind of ['regular','professional'])await installAliasTriggers(pool,{kind,links:await references(pool,kind)});
 await require('../utils/workforceMergeRecovery').installRecoveryTriggers(pool);
};
const filename=path.join(__dirname,'../routes/workforceReviewRoutes.js');
const mocks={'../utils/employeeAliases':{ensureMergeSchema:mergeMigration},express:{Router:()=>router},'../config/db':pool,'../middleware/authMiddleware':(req,res,next)=>next(),
 '../middleware/cityScope':{attachCityScope:(req,res,next)=>{req.cityScope={all:req.user.user_id!==3,ids:[1]};next();}},
 '../middleware/permissionMiddleware':{authorize:(_module,action)=>(req,res,next)=>req.reviewActor.user_id===4 || (req.reviewActor.user_id===3 && action==='write') ? res.status(403).json({message:'Forbidden'}) : next(),getPermissionCityFilter:req=>req.cityScope.all ? null : req.cityScope.ids},
 '../utils/userKothiAccess':{fetchUserKothiAccess:async()=>({ids:[10]})}};
vm.runInNewContext('(function(require,module,__dirname){'+fs.readFileSync(filename,'utf8')+'})',{console,process})(name=>mocks[name] || require(require.resolve(name,{paths:[path.dirname(filename)]})),{exports:{}},path.dirname(filename));
async function call(verb,route,{user=1,body={},query={},params={}}={}){
 // Normal fixture merges explicitly model the superadmin's identity confirmation.
 if(route==='/:kind/:id/merge')body={identityConfirmed:true,...body};
 const req={user:{user_id:user},body,query,params};
 const res={code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
 const match=routes.find(r=>r.verb===verb && r.route===route);assert.ok(match);
 for(const fn of [...middleware,...match.handlers]){let next=false;await fn(req,res,()=>{next=true;});if(!next)break;}
 return res;
}
const pro='11111111-1111-4111-8111-111111111111',pro2='22222222-2222-4222-8222-222222222222';
(async()=>{
 await db.exec(`CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,email TEXT,role TEXT,permissions JSONB,is_deleted BOOLEAN DEFAULT FALSE);
 INSERT INTO users VALUES(1,'Owner','owner@example.test','super_admin',NULL,false),(2,'Supervisor','s@example.test','supervisor',NULL,false),(3,'Scoped admin','a@example.test','admin','{}',false),(4,'No access','b@example.test','admin','{}',false);
 CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT); INSERT INTO cities VALUES(1,'One'),(2,'Two');
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(1,1),(2,2);
 CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,ward_name TEXT);INSERT INTO wards VALUES(10,1,'Site one'),(20,2,'Site two');
 CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,ward_id INT,face_id TEXT,face_embedding TEXT,is_deleted BOOLEAN);
 INSERT INTO employee VALUES(1,'Ashutosh','R1','999',10,'face',NULL,false),(2,'Ashutosh','R2','998',NULL,NULL,NULL,true),(3,'Elsewhere','R3','997',20,NULL,NULL,false);
 CREATE TABLE attendance(id SERIAL PRIMARY KEY,emp_id INT REFERENCES employee,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,mid_shift_punch_in_time TIMESTAMP,leave_type TEXT);
 INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(1,'2026-10-21','2026-10-21 09:00');
 INSERT INTO attendance(emp_id,date,leave_type) VALUES(1,'2026-10-21','casual');
 CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,city_id INT,kothi_id INT,is_active BOOLEAN,selfie_url TEXT);
 INSERT INTO professional_employees VALUES('${pro}','Ashutosh','P1','999',1,10,false,'photo'),('${pro2}','Ashutosh','P2','996',1,10,true,NULL);
 CREATE TABLE professional_attendance(id SERIAL PRIMARY KEY,professional_id UUID REFERENCES professional_employees,date DATE,punch_in TIMESTAMP,punch_out TIMESTAMP);
 INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES('${pro}','2026-10-21','2026-10-21 09:00');
 CREATE TABLE professional_leave_requests(id SERIAL PRIMARY KEY,professional_id UUID REFERENCES professional_employees,requested_date DATE,status TEXT);
 INSERT INTO professional_leave_requests(professional_id,requested_date,status) VALUES('${pro2}','2026-10-21','approved');
 CREATE TABLE leave_notes(id SERIAL PRIMARY KEY,request_id INT REFERENCES professional_leave_requests,note TEXT);
 INSERT INTO leave_notes(request_id,note) SELECT id,'keep or delete with parent' FROM professional_leave_requests;`);
 await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/20261021_workforce_review.sql'),'utf8'));
 const dates={startDate:'2026-10-21',endDate:'2026-10-21'};
 let r=await call('post','/summary',{body:dates});assert.equal(r.code,200);assert.equal(r.data.data.totalEmployees,5);assert.equal(r.data.data.present,2);assert.equal(r.data.data.onLeave,1);assert.equal(r.data.data.notMarked,2);assert.equal(r.data.data.breakdown.professional.totalEmployees,2);
 r=await call('post','/summary',{body:{...dates,user_id:7}});assert.equal(r.data.data.totalEmployees,3);
 r=await call('get','/',{query:{...dates,search:'ashutosh'}});assert.equal(r.code,200);assert.equal(r.data.total,4);assert.ok(r.data.data.every(row=>row.signals.includes('Same name')));assert.ok(r.data.data.some(row=>row.deleted==='true'));assert.equal(r.data.canHardDelete,true);
 for (const [kind,status,total] of [['all','all',5],['professional','all',2],['all','present',2],['all','notMarked',2],['all','onLeave',1],['all','faceRegistered',2],['regular','midShiftPunchIn',0]]) {
   const details=await call('get','/',{query:{...dates,kind,status}});
   assert.equal(details.code,200);
   assert.equal(details.data.total,total,`${kind}/${status} detail count must match its dashboard card`);
   if(['present','notMarked','onLeave'].includes(status)) assert.ok(details.data.data.every(row=>row.status===status));
   if(kind!=='all') assert.ok(details.data.data.every(row=>row.kind===kind));
 }
 assert.equal((await call('get','/',{user:2})).code,403);assert.equal((await call('get','/',{user:4})).code,403);
 r=await call('get','/',{user:3,query:dates});assert.equal(r.data.total,3);assert.equal(r.data.canHardDelete,false);
 assert.equal((await call('post','/:kind/:id/issues',{user:3,params:{kind:'regular',id:'1'},body:{reason:'duplicate'}})).code,403);
 const params={kind:'professional',id:pro};
 assert.equal((await call('get','/:kind/:id/delete-preview',{user:3,params})).code,403);
 assert.equal((await call('delete','/:kind/:id',{user:3,params,body:{confirmation:pro,reason:'Forbidden delete'}})).code,403);
 r=await call('post','/:kind/:id/issues',{params,body:{reason:'Review duplicate employee'}});assert.equal(r.code,201);const issueId=r.data.data.id;
 r=await call('patch','/:kind/:id/issues/:issueId',{params:{...params,issueId},body:{status:'done'}});assert.equal(r.data.data.status,'done');
 r=await call('get','/',{query:{...dates,review:'done'}});assert.equal(r.data.total,1);
 r=await call('get','/:kind/:id/delete-preview',{params});assert.equal(r.code,200);let preview=r.data;assert.ok(preview.affected.some(a=>a.table==='professional_attendance'));
 r=await call('delete','/:kind/:id',{params,body:{reason:'Confirmed duplicate',confirmation:pro,fingerprint:'stale'}});assert.equal(r.code,409);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,2);
 await db.query('UPDATE professional_employees SET is_active=true WHERE id=$1',[pro]);
 r=await call('delete','/:kind/:id',{params,body:{reason:'Changed row test',confirmation:pro,fingerprint:preview.fingerprint}});assert.equal(r.code,409);
 preview=(await call('get','/:kind/:id/delete-preview',{params})).data;
 r=await call('delete','/:kind/:id',{params,body:{reason:'Confirmed duplicate',confirmation:pro,fingerprint:preview.fingerprint}});assert.equal(r.code,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM workforce_deletion_audit')).rows[0].n,1);
 const params2={kind:'professional',id:pro2};
 r=await call('get','/:kind/:id/delete-preview',{params:params2});assert.ok(r.data.affected.some(a=>a.table==='leave_notes'));
 const nestedPreview=r.data;
 r=await call('delete','/:kind/:id',{params:params2,body:{reason:'Nested dependency test',confirmation:pro2,fingerprint:nestedPreview.fingerprint}});assert.equal(r.code,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM leave_notes')).rows[0].n,0);
 const regularParams={kind:'regular',id:'1'};
 const regularPreview=(await call('get','/:kind/:id/delete-preview',{params:regularParams})).data;
 r=await call('delete','/:kind/:id',{params:regularParams,body:{reason:'Regular employee fixture',confirmation:'1',fingerprint:regularPreview.fingerprint}});assert.equal(r.code,200);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM employee')).rows[0].n,2);
 // Merge fixtures are independent of deletion fixtures above.
 await db.exec(`INSERT INTO employee VALUES
 (10,'Merge Person','M10','9998887777',10,'main-face','embedding',false),
 (11,'Merge Person','M11','9998887777',10,'old-face','embedding',false),
 (12,'Merge Person','M12','9998887777',10,'third-face','embedding',false),
 (13,'Different Person','X13','1112223333',10,NULL,NULL,false),
 (14,'Merge Person','M14','9998887777',20,'face','embedding',false);
 INSERT INTO attendance(emp_id,date,punch_in_time,punch_out_time) VALUES
 (10,'2026-10-19','2026-10-19 09:00','2026-10-19 18:00'),
 (11,'2026-10-20','2026-10-20 09:00',NULL),(12,'2026-10-21','2026-10-21 09:00',NULL);
 CREATE TABLE legacy_employee_notes(id SERIAL PRIMARY KEY,emp_id INT,note TEXT);
 INSERT INTO legacy_employee_notes(emp_id,note) VALUES(11,'retain non-FK reference');`);
 const mergeParams={kind:'regular',id:'10'};
 const mergeBody={sourceIds:['11']};
 assert.equal((await call('get','/',{query:{...dates,search:'M10'}})).data.data[0].duplicate_count,3);
 const candidates=(await call('get','/:kind/:id/duplicates',{params:mergeParams,query:dates})).data;
 assert.equal(candidates.candidates.length,3);
 assert.equal((await call('post','/:kind/:id/merge-preview',{user:3,params:mergeParams,body:mergeBody})).code,403);
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:{sourceIds:['13']}})).code,400);
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:{sourceIds:['14']}})).code,409);
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:{sourceIds:['10']}})).code,400);
 let mp=await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:mergeBody});
 assert.equal(mp.code,200,JSON.stringify(mp.data));
 assert.equal((await db.query('SELECT emp_id FROM attendance WHERE date=$1',['2026-10-20'])).rows[0].emp_id,11,'preview must not persist changes');
 const submit={...mergeBody,fingerprint:mp.data.fingerprint,confirmation:'10',reason:'Confirmed same person'};
 await db.query("UPDATE attendance SET punch_out_time='2026-10-20 18:00' WHERE emp_id=11");
 assert.equal((await call('post','/:kind/:id/merge',{params:mergeParams,body:submit})).code,409);
 mp=await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:mergeBody});
 const before=(await db.query('SELECT id,date,punch_in_time,punch_out_time FROM attendance WHERE emp_id IN (10,11) ORDER BY id')).rows;
 r=await call('post','/:kind/:id/merge',{params:mergeParams,body:{...submit,fingerprint:mp.data.fingerprint}});
 assert.equal(r.code,200,JSON.stringify(r.data));
 assert.deepEqual((await db.query('SELECT id,date,punch_in_time,punch_out_time FROM attendance WHERE emp_id=10 ORDER BY id')).rows,before);
 assert.equal((await db.query('SELECT emp_id FROM legacy_employee_notes')).rows[0].emp_id,10);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM employee WHERE emp_id=11')).rows[0].n,0);
 assert.equal((await db.query("SELECT target_id FROM workforce_employee_aliases WHERE source_id='11'")).rows[0].target_id,'10');
 assert.equal((await db.query('SELECT profile_snapshots FROM workforce_merge_audit')).rows[0].profile_snapshots.length,2);
 assert.equal((await call('post','/:kind/:id/merge',{params:mergeParams,body:{...submit,fingerprint:mp.data.fingerprint}})).code,404,'repeat merge must not duplicate anything');
 const dp=(await call('get','/:kind/:id/delete-preview',{params:mergeParams})).data;
 assert.equal((await call('delete','/:kind/:id',{params:mergeParams,body:{confirmation:'10',reason:'Prevent data loss',fingerprint:dp.fingerprint}})).code,409);
 // Simultaneous dates must not be collapsed or overwritten, even without a unique index.
 await db.query("INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(12,'2026-10-19','2026-10-19 10:00')");
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:{sourceIds:['12']}})).code,409);
 await db.query("DELETE FROM attendance WHERE emp_id=12 AND date='2026-10-19'");
 await db.exec("CREATE UNIQUE INDEX fixture_single_note ON legacy_employee_notes(emp_id); INSERT INTO legacy_employee_notes(emp_id,note) VALUES(12,'conflicting settings');");
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:mergeParams,body:{sourceIds:['12']}})).code,409);
 assert.equal((await db.query('SELECT emp_id FROM legacy_employee_notes WHERE note=$1',['conflicting settings'])).rows[0].emp_id,12);
 await db.exec('DROP INDEX fixture_single_note');
 // Alias chains are flattened when the former main ID is merged again.
 const nextParams={kind:'regular',id:'12'},nextBody={sourceIds:['10']};
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:nextParams,body:nextBody})).code,409,'Another merge must not invalidate an open recovery window');
 await db.query("UPDATE workforce_merge_audit SET restore_until=NOW()-INTERVAL '1 second'");
 mp=await call('post','/:kind/:id/merge-preview',{params:nextParams,body:nextBody});assert.equal(mp.code,200);
 r=await call('post','/:kind/:id/merge',{params:nextParams,body:{...nextBody,confirmation:'12',reason:'Keep newest profile',fingerprint:mp.data.fingerprint}});assert.equal(r.code,200,JSON.stringify(r.data));
 assert.equal((await db.query("SELECT target_id FROM workforce_employee_aliases WHERE source_id='11'")).rows[0].target_id,'12');
 // Old IDs continue to work for offline writes, regular logins and active professional tokens.
 await db.query("INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(11,'2026-10-22','2026-10-22 09:00')");
 assert.equal((await db.query("SELECT emp_id FROM attendance WHERE date='2026-10-22'")).rows[0].emp_id,12);
 function loadWithPool(relative,other={}) {
  const file=path.join(__dirname,relative),module={exports:{}};
  vm.runInNewContext('(function(require,module,__dirname){'+fs.readFileSync(file,'utf8')+'})',{console,process})(name=>other[name] || (name.endsWith('/config/db')?pool:require(require.resolve(name,{paths:[path.dirname(file)]}))),module,path.dirname(file));
  return module.exports;
 }
 const aliases=loadWithPool('../utils/employeeAliases.js');
 await aliases.ensureMergeSchema();
 assert.equal(await aliases.resolveEmployeeAlias('regular','11'),'12');
 assert.equal(await aliases.resolveEmployeeAlias('regular','99999'),'99999');
 const request={body:{emp_id:11,userId:99},query:{empId:'10'}};
 let continued=false;await aliases.resolveRegularRequest(request,{},()=>{continued=true;});assert.equal(continued,true);assert.equal(request.body.emp_id,'12');assert.equal(request.query.empId,'12');assert.equal(request.body.userId,99);
 await db.exec('ALTER TABLE employee ADD COLUMN face_confidence NUMERIC, ADD COLUMN self_attendance_enabled BOOLEAN DEFAULT FALSE');
 const selfAttendance=loadWithPool('../utils/selfAttendance.js',{'./employeeAliases':aliases});
 assert.equal((await selfAttendance.fetchEmployeeById(11)).emp_id,12);
 assert.equal((await selfAttendance.fetchEmployeeByCode('M11')).emp_id,12);
 // Professional merges preserve the existing login identifiers and password hash.
 await db.exec(`ALTER TABLE professional_employees ADD COLUMN email TEXT,ADD COLUMN password_hash TEXT;
 INSERT INTO professional_employees(id,full_name,emp_code,mobile,city_id,kothi_id,is_active,selfie_url,email,password_hash) VALUES
 ('${pro}','Pro Merge','PM1','9998886666',1,10,true,'same-photo','same@example.test','same-hash'),
 ('${pro2}','Pro Merge','PM2','9998886666',1,10,true,'same-photo','same@example.test','same-hash');
 INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES('${pro2}','2026-10-20','2026-10-20 09:00');`);
 const pp={kind:'professional',id:pro},pb={sourceIds:[pro2]};
 await db.query("UPDATE professional_employees SET password_hash='different-hash' WHERE id=$1",[pro2]);
 assert.equal((await call('post','/:kind/:id/merge-preview',{params:pp,body:pb})).code,200,'Different password hashes must not block merging');
 await db.query("UPDATE professional_employees SET password_hash='same-hash' WHERE id=$1",[pro2]);
 mp=await call('post','/:kind/:id/merge-preview',{params:pp,body:pb});assert.equal(mp.code,200,JSON.stringify(mp.data));
 r=await call('post','/:kind/:id/merge',{params:pp,body:{...pb,confirmation:pro,reason:'Verified professional duplicates',fingerprint:mp.data.fingerprint}});assert.equal(r.code,200,JSON.stringify(r.data));
 assert.equal(await aliases.resolveEmployeeAlias('professional',pro2),pro);
 assert.equal((await db.query('SELECT professional_id FROM professional_attendance WHERE date=$1',['2026-10-20'])).rows[0].professional_id,pro);
 await db.exec('ALTER TABLE professional_employees ADD COLUMN zone_id INT DEFAULT 1,ADD COLUMN ward_id INT DEFAULT 10;');
 const auth=loadWithPool('../middleware/professionalAuth.js',{'jsonwebtoken':{verify:()=>({professional_id:pro2,city_id:999})},'../utils/employeeAliases':aliases});
 const authReq={header:()=> 'Bearer valid-token',cookies:{}},authRes={status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
 continued=false;await auth(authReq,authRes,()=>{continued=true;});assert.equal(continued,true,JSON.stringify(authRes));assert.equal(authReq.professional.professional_id,pro);assert.equal(authReq.professional.city_id,1);
 // Production enforces one professional attendance row per date.
 await db.exec(`CREATE UNIQUE INDEX fixture_professional_daily ON professional_attendance(professional_id,date);
 ALTER TABLE professional_attendance ADD COLUMN punch_approval_status TEXT DEFAULT 'accepted',ADD COLUMN city_id INT DEFAULT 1,ADD COLUMN note TEXT,ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
 CREATE TABLE professional_punch_evidence(id SERIAL PRIMARY KEY,attendance_id INT REFERENCES professional_attendance(id),label TEXT);`);
 let caseNumber=10;
 async function professionalCase(label,entries,{blocked=false,expectedDays,afterPreview,beforePreview,expectedMerged}={}) {
  const n=caseNumber++,ids=[1,2,3].map(i=>`a0000000-0000-4000-8000-${String(n*10+i).padStart(12,'0')}`);
  for(const id of ids) await db.query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,city_id,kothi_id,is_active,selfie_url,email,password_hash) VALUES($1,'Ashu','ASHU-SAME','9876543210',1,10,true,'same-face','ashu@example.test','same-hash')`,[id]);
  for(const entry of entries) await db.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,punch_out,punch_approval_status,city_id,note) VALUES($1,$2,$3,$4,$5,$6,$7)`,[ids[entry.person],entry.date,entry.in || null,entry.out || null,entry.status || 'accepted',entry.city ?? 1,entry.note ?? null]);
  if(beforePreview) await beforePreview(ids);
  const original=(await db.query('SELECT to_jsonb(a) AS row FROM professional_attendance a WHERE professional_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(result=>result.row);
  const cp={kind:'professional',id:ids[0]},cb={sourceIds:ids.slice(1)};
  const pv=await call('post','/:kind/:id/merge-preview',{params:cp,body:cb});
  assert.equal(pv.code,blocked?409:200,`${label}: ${JSON.stringify(pv.data)}`);
  assert.deepEqual((await db.query('SELECT to_jsonb(a) AS row FROM professional_attendance a WHERE professional_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(result=>result.row),original,`${label}: preview never mutates data`);
  if(blocked) {
   assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees WHERE id=ANY($1::uuid[])',[ids])).rows[0].n,3);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM workforce_merge_audit WHERE target_id=$1',[ids[0]])).rows[0].n,0);
   console.log(`PASS: ${label} (safely blocked; all rows retained)`);return;
  }
  assert.equal(pv.data.attendance.uniqueDays,expectedDays,`${label}: preview day count`);
  if(afterPreview) {
   await afterPreview(ids);
   const changed=(await db.query('SELECT to_jsonb(a) AS row FROM professional_attendance a WHERE professional_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(result=>result.row);
   const stale=await call('post','/:kind/:id/merge',{params:cp,body:{...cb,confirmation:ids[0],reason:label,fingerprint:pv.data.fingerprint}});
   assert.equal(stale.code,409,label);
   assert.deepEqual((await db.query('SELECT to_jsonb(a) AS row FROM professional_attendance a WHERE professional_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(result=>result.row),changed);
   assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees WHERE id=ANY($1::uuid[])',[ids])).rows[0].n,3);
   console.log(`PASS: ${label} (stale preview rolled back)`);return;
  }
  const merged=await call('post','/:kind/:id/merge',{params:cp,body:{...cb,confirmation:ids[0],reason:label,fingerprint:pv.data.fingerprint}});
  assert.equal(merged.code,200,`${label}: ${JSON.stringify(merged.data)}`);
  const final=(await db.query('SELECT to_jsonb(a) AS row FROM professional_attendance a WHERE professional_id=$1 ORDER BY date',[ids[0]])).rows.map(result=>result.row);
  assert.equal(final.length,expectedDays,label);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees WHERE id=ANY($1::uuid[])',[ids])).rows[0].n,1);
  for(const id of ids.slice(1)) assert.equal(await aliases.resolveEmployeeAlias('professional',id),ids[0]);
  const audit=(await db.query('SELECT * FROM workforce_merge_audit WHERE target_id=$1',[ids[0]])).rows[0];
  assert.equal(audit.profile_snapshots.length,3);
  const originalByDate=new Map();for(const row of original) originalByDate.set(row.date,(originalByDate.get(row.date)||0)+1);
  const originalsOverlapping=original.filter(row=>originalByDate.get(row.date)>1);
  assert.equal(audit.attendance_snapshots.length,originalsOverlapping.length,`${label}: all overlapping originals archived`);
  for(const row of originalsOverlapping) assert.ok(audit.attendance_snapshots.some(snapshot=>snapshot.id===row.id && snapshot.professional_id===row.professional_id),`${label}: original attendance identity retained in audit`);
  if(expectedMerged) await expectedMerged(final,ids,original);
  console.log(`PASS: ${label} (${original.length} rows -> ${final.length} unique attendance days)`);
 }
 const day=(person,date,inTime='09:00',outTime='18:00',extra={})=>({person,date,in:inTime && `${date} ${inTime}`,out:outTime && `${date} ${outTime}`,...extra});
 await professionalCase('Requested example: 12,13 plus 11,14 plus 11,20 counts five present dates',[
  day(0,'2026-10-12'),day(0,'2026-10-13'),day(1,'2026-10-11'),day(1,'2026-10-14'),day(2,'2026-10-11'),day(2,'2026-10-20'),
 ],{expectedDays:5,expectedMerged:async final=>assert.deepEqual(final.map(row=>row.date).sort(),['2026-10-11','2026-10-12','2026-10-13','2026-10-14','2026-10-20'])});
 await professionalCase('Ashu: three IDs, same code/mobile, 2 + 3 days with one common date',[
  day(0,'2026-10-01'),day(0,'2026-10-02'),
  day(1,'2026-10-02'),day(1,'2026-10-03'),day(1,'2026-10-04'),day(2,'2026-10-02')
 ],{expectedDays:4,beforePreview:async ids=>{
  await db.query(`INSERT INTO professional_punch_evidence(attendance_id,label) SELECT id,'keep evidence' FROM professional_attendance WHERE professional_id=ANY($1::uuid[]) AND date='2026-10-02'`,[ids]);
 },expectedMerged:async(final,ids,original)=>{
  const kept=final.find(row=>row.date==='2026-10-02');
  assert.equal(kept.id,original.find(row=>row.professional_id===ids[0] && row.date==='2026-10-02').id);
  const evidence=(await db.query('SELECT attendance_id FROM professional_punch_evidence')).rows;
  assert.equal(evidence.length,3);assert.ok(evidence.every(row=>row.attendance_id===kept.id));
  assert.ok(final.every(row=>row.punch_in.endsWith('09:00:00') && row.punch_out.endsWith('18:00:00')));
 }});
 await professionalCase('Exactly 2 + 3 days with one common date and an empty third ID',[day(0,'2026-10-01'),day(0,'2026-10-02'),day(1,'2026-10-02'),day(1,'2026-10-03'),day(1,'2026-10-04')],{expectedDays:4});
 await professionalCase('Three profiles without any attendance',[],{expectedDays:0});
 await professionalCase('Pending punches stay pending and do not become present',[day(0,'2026-10-01',null,null,{status:'pending_pm'}),day(1,'2026-10-01',null,null,{status:'pending_pm'})],{expectedDays:1,expectedMerged:async(final,ids)=>{
  assert.equal(final[0].punch_in,null);assert.equal(final[0].punch_approval_status,'pending_pm');
  const detail=await call('get','/',{query:{startDate:'2026-10-01',endDate:'2026-10-01',search:ids[0]}});
  assert.equal(detail.data.total,1);assert.equal(detail.data.data[0].status,'notMarked');
 }});
 await professionalCase('No overlapping dates',[day(0,'2026-10-01'),day(1,'2026-10-02'),day(2,'2026-10-03')],{expectedDays:3});
 await professionalCase('Main ID has no attendance; two source IDs overlap',[day(1,'2026-10-01'),day(2,'2026-10-01')],{expectedDays:1});
 await professionalCase('Missing punch-out completed from matching duplicate',[day(0,'2026-10-01','09:00',null),day(1,'2026-10-01')],{expectedDays:1,expectedMerged:async final=>assert.ok(final[0].punch_out.endsWith('18:00:00'))});
 await professionalCase('Complementary punch-in and punch-out',[day(0,'2026-10-01','09:00',null),day(1,'2026-10-01',null,'18:00')],{expectedDays:1});
 await professionalCase('Still open after merge: no synthetic punch-out',[day(0,'2026-10-01','09:00',null),day(1,'2026-10-01','09:00',null)],{expectedDays:1,expectedMerged:async(final,ids)=>{
  assert.equal(final[0].punch_out,null);
  await db.query("UPDATE professional_attendance SET punch_out='2026-10-01 18:00' WHERE professional_id=$1 AND date='2026-10-01'",[await aliases.resolveEmployeeAlias('professional',ids[1])]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance WHERE professional_id=$1',[ids[0]])).rows[0].n,1);
 }});
 for(const [label,second] of [
  ['Conflicting punch-in',day(1,'2026-10-01','10:00')],
  ['Conflicting punch-out',day(1,'2026-10-01','09:00','19:00')],
  ['Conflicting location',day(1,'2026-10-01','09:00','18:00',{city:2})],
  ['Accepted versus rejected approval',day(1,'2026-10-01','09:00','18:00',{status:'rejected'})],
  ['Conflicting non-time metadata',day(1,'2026-10-01','09:00','18:00',{note:'different note'})]
 ]) await professionalCase(label,[day(0,'2026-10-01','09:00','18:00',{note:label.includes('metadata')?'original note':null}),second],{blocked:true});
 await professionalCase('Complementary punches with invalid time order',[day(0,'2026-10-01','10:00',null),day(1,'2026-10-01',null,'09:00')],{blocked:true});
 await professionalCase('Metadata fills a missing value',[day(0,'2026-10-01'),day(1,'2026-10-01','09:00','18:00',{note:'original evidence'})],{expectedDays:1,expectedMerged:async final=>assert.equal(final[0].note,'original evidence')});
 await professionalCase('Punch changes after overlap preview',[day(0,'2026-10-01','09:00',null),day(1,'2026-10-01','09:00',null)],{expectedDays:1,afterPreview:async ids=>{
  await db.query("UPDATE professional_attendance SET punch_out='2026-10-01 18:00' WHERE professional_id=$1",[ids[1]]);
 }});
 await db.exec("CREATE UNIQUE INDEX fixture_unique_evidence ON professional_punch_evidence(attendance_id,label) WHERE label='same-label';");
 await professionalCase('Dependent evidence conflict rolls back consolidation',[day(0,'2026-10-01'),day(1,'2026-10-01')],{blocked:true,beforePreview:async ids=>{
  await db.query(`INSERT INTO professional_punch_evidence(attendance_id,label) SELECT id,'same-label' FROM professional_attendance WHERE professional_id=ANY($1::uuid[])`,[ids]);
 }});
 await db.query(`INSERT INTO employee(emp_id,name,emp_code,phone,ward_id,face_embedding) VALUES
 (800,'Restore Person','UNDO800','8888888888',10,'face'),(801,'Restore Person','UNDO801','8888888888',10,'face')`);
 await db.query("INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(801,'2026-10-10','2026-10-10 09:00')");
 const undoParams={kind:'regular',id:'800'};
 const undoPreview=await call('post','/:kind/:id/merge-preview',{params:undoParams,body:{sourceIds:['801']}});
 assert.equal(undoPreview.code,200);
 const merged=await call('post','/:kind/:id/merge',{params:undoParams,body:{sourceIds:['801'],confirmation:'800',reason:'Recovery fixture',fingerprint:undoPreview.data.fingerprint}});
 assert.equal(merged.code,200);
 await db.query("INSERT INTO attendance(emp_id,date,punch_in_time) VALUES(800,'2026-10-11','2026-10-11 09:00')");
 const restoreParams={mergeId:String(merged.data.mergeId)};
 const restore=await call('post','/merges/:mergeId/revert-preview',{params:restoreParams});
 assert.equal(restore.code,200,JSON.stringify(restore.data));
 assert.equal((await db.query('SELECT count(*)::int AS n FROM employee WHERE emp_id=801')).rows[0].n,0,'Preview must not restore persistently');
 const reverted=await call('post','/merges/:mergeId/revert',{params:restoreParams,body:{confirmation:'800',reason:'Undo test merge',fingerprint:restore.data.fingerprint}});
 assert.equal(reverted.code,200,JSON.stringify(reverted.data));
 assert.equal((await db.query("SELECT emp_id FROM attendance WHERE date='2026-10-10' AND emp_id=801")).rows.length,1);
 assert.equal((await db.query("SELECT emp_id FROM attendance WHERE date='2026-10-11' AND emp_id=800")).rows.length,1,'New main punches survive');
 assert.equal((await call('post','/merges/:mergeId/revert-preview',{params:restoreParams})).code,409,'Cannot revert twice');
 console.log('PASS: merge recovery preview, exact ownership restoration, new main punches preserved and repeated revert blocked.');
 await require('./workforceMergeRecovery.integration')({db,pool,call});
 await require('./professionalMergeSession.integration')({db,pool,call});
 await require('./professionalMergeCredentials.integration')({db,pool,call});
 console.log('PASS: delayed old-ID attendance writes, old employee-code login lookup, request ID redirection, professional credential conflict protection, professional history transfer and existing-token continuity.');
 console.log('PASS: duplicate candidates, permissions, same-scope checks, stale merge rollback, unchanged attendance, non-FK references, permanent duplicate removal, audit snapshots, overlap and unique-conflict protection, deletion guard, alias chains.');
 console.log('PASS: raw inclusive counts, attendance priority, duplicate search, city scope, admin permissions, issue persistence, superadmin deletion, stale-preview rollback, nested dependencies and audit.');
 await db.close();
})().catch(async e=>{console.error(e);await db.close();process.exitCode=1;});
