// Real PostgreSQL statements, mocked face/storage providers. No live services are used.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(run){const db=new PGlite();try{
 await db.exec(`CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(1,1),(2,2);
 CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT,zone_id INT);INSERT INTO wards VALUES(10,'Kothi A',1),(20,'Kothi B',2);
 CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,ward_id INT,phone TEXT,face_embedding TEXT,self_attendance_enabled BOOLEAN DEFAULT FALSE,is_active BOOLEAN DEFAULT TRUE);
 CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,is_active BOOLEAN DEFAULT TRUE);
 CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT);INSERT INTO designation VALUES(1,'Project Head / Site Head'),(2,'HO Coordinator'),(3,'Head of Department');
 CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);
 CREATE TABLE professional_site_access(professional_id UUID,kothi_id INT);
 CREATE TABLE attendance(attendance_id SERIAL PRIMARY KEY,emp_id INT,date DATE,ward_id INT,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,
  mid_shift_punch_in_time TIMESTAMPTZ,leave_type TEXT,latitude_in DOUBLE PRECISION,longitude_in DOUBLE PRECISION,
  latitude_out DOUBLE PRECISION,longitude_out DOUBLE PRECISION,in_address TEXT,out_address TEXT,punch_in_image TEXT,punch_out_image TEXT,UNIQUE(emp_id,date));`);
 for(const file of ['20261026_register_attendance.sql','20261026_supervisor_attendance.sql','20261026_supervisor_attendance.sql'])await db.exec(fs.readFileSync('db/migrations/'+file,'utf8'));
 for(let n=1;n<=4;n++){await db.query('INSERT INTO professional_employees VALUES($1,$2,$3,TRUE)',[id(n),'Supervisor '+n,'P'+n]);await db.query('INSERT INTO professional_designation_assignments VALUES($1,$2)',[id(n),n===2?2:n===3?3:1]);await db.query('INSERT INTO professional_site_access VALUES($1,$2)',[id(n),n===4?20:10]);}
 for(let n=1;n<=8;n++)await db.query('INSERT INTO employee(emp_id,name,emp_code,ward_id,face_embedding) VALUES($1,$2,$3,$4,$5)',[n,'Worker '+n,'E'+n,n===8?20:10,n===7?'legacy-face.jpg':null]);
 let counter=0;const state={matchIds:[1],normalizeFails:false,onMatch:null,uploaded:[],deleted:[],indexed:[],deletedFaces:[]};
 const faceApi={collectionFor:site=>'matrixtrack-supervisor-site-'+site,
  normalize:async buffer=>{if(state.normalizeFails)throw Error('Bad image');return buffer;},readPhoto:async()=>Buffer.from('stored-photo'),
  putPhoto:async(buffer,folder)=>{const key=`supervisor-attendance/${folder}/${++counter}.jpg`;state.uploaded.push(key);return key;},
  discardPhoto:async key=>state.deleted.push(key),discardFace:async(site,face)=>state.deletedFaces.push({site,face}),getPhotoUrl:async key=>'https://signed.test/'+key,
  indexFace:async(site,emp)=>{state.indexed.push({site,emp});if(state.indexError)throw state.indexError;return {faceId:`face-${emp}-${++counter}`,collectionId:'matrixtrack-supervisor-site-'+site};},
  matchFaces:async(site,image,roster)=>{if(state.onMatch)await state.onMatch();return state.matchIds.map((emp,i)=>{const employee=roster.find(p=>p.emp_id===emp);return employee?{face:i+1,employee,similarity:99}:{face:i+1,reason:'No matching employee in this kothi'};});},
 };
 state.queries=[];state.releasedErrors=[];
 const query=async(sql,params)=>{state.queries.push(sql);
  if(sql==='COMMIT'&&state.failCommitOnce){state.failCommitOnce=false;await db.query(sql,params);throw Error('Query read timeout');}
  return sql.includes('pg_try_advisory_lock')?{rows:[{locked:true}]}:sql.includes('pg_advisory_')?{rows:[]}:db.query(sql,params);
 };
 const pool={query,connect:async()=>({query,release(error){state.releasedErrors.push(error?.message||null);}})};
 const caps={exports:{}};vm.runInNewContext(fs.readFileSync('utils/professionalPunchCutoff.js','utf8'),{module:caps,require:name=>name==='fs'?fs:name==='path'?require('node:path'):pool});
 const deps={'node:crypto':crypto,'./professionalPunchCutoff':caps.exports,'./supervisorFaceIndex':faceApi,'./employeeAttendanceMode':require('../utils/employeeAttendanceMode')};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync('utils/supervisorAttendance.js','utf8'),{module,Buffer,require:name=>deps[name]});const api=module.exports;
 const enroll=(emp=1,actor=id(1),site=10,file={buffer:Buffer.from('photo-'+emp)},extra={})=>api.enroll(pool,actor,{site_id:site,emp_id:emp,consent_given:true,...extra},file);
 const punch=(type='in',group=true,key='capture_reference_001',actor=id(1),site=10,emp=1)=>api.punch(pool,actor,{site_id:site,group,punch_type:type,emp_id:emp,request_key:key,latitude:22,longitude:75},{buffer:Buffer.from('capture-'+key)});
 const manual=async(emp=1)=>db.query(`INSERT INTO register_attendance_requests(emp_id,site_id,requested_by,duration_days,reason,status,ho_reviewer_id,hod_reviewer_id,starts_on,ends_on)
  VALUES($1,10,$2,30,'No phone','approved',$3,$4,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+29)`,[emp,id(1),id(2),id(3)]);
 const routeModule={exports:{}};const fakeMulter=()=>({single:()=> (req,res,next)=>next()});fakeMulter.memoryStorage=()=>({});
 const routeDeps={'express':require('express'),'multer':fakeMulter,'../config/db':pool,'../middleware/professionalAuth':(req,res,next)=>req.professional?next():res.status(401).json({success:false}),
  '../utils/professionalPunchCutoff':caps.exports,'../utils/supervisorAttendance':api,'../utils/supervisorFaceIndex':faceApi};
 vm.runInNewContext(fs.readFileSync('routes/supervisorAttendanceRoutes.js','utf8'),{module:routeModule,console,require:name=>routeDeps[name]});
 const call=(url,actor=id(1),queryParams={site_id:'10'})=>new Promise((resolve,reject)=>routeModule.exports.handle({method:'GET',url,query:queryParams,headers:{},professional:actor?{professional_id:actor}:null},{statusCode:200,status(n){this.statusCode=n;return this;},json(data){resolve({code:this.statusCode,...data});}},e=>e?reject(e):resolve({code:404})));
 await run({db,pool,api,state,faceApi,enroll,punch,manual,call,id});
 }finally{await db.close();}}

test('HR-created regular employees need no approval; one-time face storage and saved-photo reuse are scoped',()=>fixture(async({db,api,state,enroll,call})=>{
 const before=(await db.query('SELECT * FROM employee WHERE emp_id=7')).rows[0];
 await enroll();assert.equal(state.indexed.length,1);assert.equal((await call('/employees')).data.find(p=>p.emp_id===1).face_stored,true);
 await assert.rejects(enroll(),/already stored/);assert.equal(state.indexed.length,1);
 await enroll(7,id(1),10,null);assert.deepEqual((await db.query('SELECT * FROM employee WHERE emp_id=7')).rows[0],before);
 await assert.rejects(enroll(8),/unavailable/);await assert.rejects(enroll(1,id(2)),/Project Head/);
 await assert.rejects(enroll(2,id(1),10,{buffer:Buffer.from('x')},{consent_given:false}),/agreed/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM register_attendance_requests')).rows[0].n,0);
}));
test('group capture only marks matched current-kothi employees and never overwrites an existing punch',()=>fixture(async({db,state,enroll,punch})=>{
 await enroll(1);await enroll(2);state.matchIds=[1,2,8,99];let result=await punch();assert.equal(result.marked,2);
 assert.equal(result.results.filter(r=>r.status==='skipped').length,2);
 const before=(await db.query('SELECT * FROM attendance ORDER BY emp_id')).rows;
 assert.equal(before[0].supervisor_in_by,id(1));assert.equal(before[0].supervisor_in_name,'Supervisor 1');assert.ok(before[0].punch_in_time);assert.equal(before[0].punch_out_time,null);
 assert.equal(before[0].supervisor_in_capture,before[1].supervisor_in_capture,'One private capture is referenced by both employees');
 assert.equal(before[0].punch_in_image,null,'The public legacy image endpoint receives no group-photo storage reference');
 assert.equal(before[0].punch_in_time.getTime(),before[1].punch_in_time.getTime(),'All employees in one group use the same captured instant');
 assert.ok((await db.query('SELECT image_key FROM supervisor_attendance_captures WHERE id=$1',[before[0].supervisor_in_capture])).rows[0].image_key,'Original evidence remains in the private capture record');
 result=await punch('in',true,'capture_reference_002');assert.equal(result.marked,0);assert.deepEqual((await db.query('SELECT * FROM attendance ORDER BY emp_id')).rows,before);
 result=await punch('out',true,'capture_reference_003');assert.equal(result.marked,2);assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance WHERE punch_out_time IS NOT NULL')).rows[0].n,2);
}));
test('individual matching, idempotency and reusing a capture key with different actions are enforced',()=>fixture(async({db,state,enroll,punch,api,pool})=>{
 await enroll(1);await enroll(2);state.matchIds=[2];assert.equal((await punch('in',false)).marked,0);
 state.matchIds=[1];const result=await punch('in',false,'capture_reference_010');const uploaded=state.uploaded.length;
 const replay=await punch('in',false,'capture_reference_010');assert.equal(replay.replayed,true);assert.equal(replay.capture_id,result.capture_id);assert.equal(state.uploaded.length,uploaded);
 await assert.rejects(punch('out',false,'capture_reference_010'),/already used/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,1);
 await assert.rejects(api.punch(pool,id(1),{site_id:10,group:true,punch_type:'in',request_key:'capture_reference_100',latitude:'',longitude:75},{buffer:Buffer.from('x')}),/location/);
}));
test('manual Register Attendance is visible and protected; an existing face punch can still finish',()=>fixture(async({db,state,enroll,punch,manual,call})=>{
 await enroll(1);await manual(1);await enroll(2);state.matchIds=[1,2];assert.equal((await punch()).marked,1);
 const listed=(await call('/employees')).data.find(p=>p.emp_id===1);assert.equal(listed.attendance_mode,'register');assert.equal(listed.register_request_status,'approved');
 await manual(2);state.matchIds=[2];assert.equal((await punch('out',true,'capture_reference_011')).marked,1,'Manual permission cannot strand an already open face punch');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance WHERE emp_id=1')).rows[0].n,0);
}));
test('transfer and face changes during recognition cannot mark attendance, and scope is checked before cloud work',()=>fixture(async({db,state,enroll,punch})=>{
 await enroll(1);const uploads=state.uploaded.length;await assert.rejects(punch('in',true,'capture_reference_020',id(1),20),/outside/);assert.equal(state.uploaded.length,uploads);
 state.onMatch=()=>db.query('UPDATE employee SET ward_id=20 WHERE emp_id=1');assert.equal((await punch()).marked,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
 state.onMatch=null;await assert.rejects(enroll(1,id(4),20,{buffer:Buffer.from('new')}),/saved photo/);await enroll(1,id(4),20,null);
 assert.equal((await db.query('SELECT site_id FROM supervisor_attendance_faces WHERE emp_id=1')).rows[0].site_id,20);
 assert.equal(state.deletedFaces[0].site,10);assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
}));
test('failed face enrollment rolls back cloud artifacts, and manual attendance rows remain untouched',()=>fixture(async({db,state,enroll,punch,manual})=>{
 await enroll(1);await manual(1);
 const request=(await db.query('SELECT id FROM register_attendance_requests WHERE emp_id=1')).rows[0];
 await db.query(`INSERT INTO attendance(emp_id,date,ward_id,register_status,register_request_id,register_marked_by,register_marked_at)
 VALUES(1,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,10,'absent',$1,$2,clock_timestamp())`,[request.id,id(1)]);
 const before=(await db.query('SELECT * FROM attendance')).rows[0];await enroll(2);state.matchIds=[1,2];await punch();assert.deepEqual((await db.query('SELECT * FROM attendance WHERE emp_id=1')).rows[0],before);
 const original=state.indexed.length;state.normalizeFails=true;await assert.rejects(enroll(3),/Bad image/);assert.equal(state.indexed.length,original);
}));
test('employee and stored-photo APIs require scope and never expose raw index identities',()=>fixture(async({enroll,call})=>{
 assert.equal((await call('/sites',null)).code,401);assert.equal((await call('/sites',id(2))).code,403);
 await enroll(1);const response=await call('/employees');assert.equal(response.code,200);const person=response.data.find(p=>p.emp_id===1);
 for(const key of ['face_id','version','photo_key','source_ref','face_embedding'])assert.equal(key in person,false);
 assert.equal((await call('/employees/1/photo')).url.startsWith('https://signed.test/'),true);
 assert.equal((await call('/employees/8/photo')).code,404);assert.equal((await call('/employees',id(4),{site_id:'10'})).code,403);
}));

test('HR attendance metadata is site/city scoped, preserves historical report state and invalidates transferred face indexes',()=>fixture(async({db,pool,enroll,punch,manual})=>{
 await enroll(1);await punch();await manual(2);
 const module={exports:{}},next=(req,res,next)=>next();
 const deps={express:require('express'),'../config/db':pool,'../middleware/authMiddleware':next,'../middleware/cityScope':{attachCityScope:next,requireCityScope:()=>next},'../middleware/kothiScope':{attachKothiScope:next},'../utils/employeeAttendanceMode':require('../utils/employeeAttendanceMode')};
 vm.runInNewContext(fs.readFileSync('routes/employeeAttendanceModesRoutes.js','utf8'),{module,Date,Number,require:n=>deps[n]});
 const call=(body,siteIds=[10],cityIds=[1])=>new Promise((resolve,reject)=>module.exports.handle({method:'POST',url:'/',headers:{},body,kothiScope:{ids:siteIds},cityScope:{ids:cityIds}},{statusCode:200,status(n){this.statusCode=n;return this;},json(data){resolve({code:this.statusCode,...data});}},reject));
 let result=await call({emp_ids:[1,2,8],date:null});assert.equal(result.code,200);assert.deepEqual(result.data.map(r=>r.emp_id),[1,2]);assert.equal(result.data[0].supervisor_face_ready,true);assert.equal(result.data[1].attendance_mode,'register');assert.equal('supervisor_in_name' in result.data[0],false);
 result=await call({emp_ids:[1]});assert.equal(result.data[0].supervisor_in_name,'Supervisor 1');
 assert.equal((await call({emp_ids:[1]},[10],[2])).data.length,0);
 assert.equal((await call({emp_ids:[1],date:'2026-02-30'})).code,400);
 await db.query('UPDATE employee SET ward_id=20 WHERE emp_id=1');result=await call({emp_ids:[1]},[20],[2]);assert.equal(result.data[0].face_stored,true);assert.equal(result.data[0].supervisor_face_ready,false);
}));

test('yesterday open punch stays available even when today has an empty attendance row',()=>fixture(async({db,enroll,api,pool,punch})=>{
 await enroll(1);await db.query(`INSERT INTO attendance(emp_id,date,ward_id,punch_in_time) VALUES(1,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-1,10,clock_timestamp() AT TIME ZONE 'Asia/Kolkata')`);
 await db.query(`INSERT INTO attendance(emp_id,date,ward_id) VALUES(1,(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date,10)`);
 assert.ok((await api.roster(pool,10)).find(p=>p.emp_id===1).punch_in_time);assert.equal((await punch('out')).marked,1);
}));

test('rejected Register Attendance defaults to supervisor mode, stays visible and permits one-time face setup and punching',()=>fixture(async({db,manual,enroll,call,punch})=>{
 await manual(1);await assert.rejects(enroll(1),/Register Attendance/);
 await db.query("UPDATE register_attendance_requests SET status='rejected' WHERE emp_id=1");
 const person=(await call('/employees')).data.find(p=>p.emp_id===1);assert.ok(person);assert.equal(person.attendance_mode,'supervisor');assert.equal(person.supervisor_face_ready,false);
 await enroll(1);assert.equal((await punch()).marked,1);
 const row=(await db.query('SELECT register_status,supervisor_in_by,punch_in_time FROM attendance WHERE emp_id=1')).rows[0];assert.equal(row.register_status,null);assert.equal(row.supervisor_in_by,id(1));assert.ok(row.punch_in_time);
 assert.equal((await db.query('SELECT status FROM register_attendance_requests WHERE emp_id=1')).rows[0].status,'rejected');
}));

test('usable saved faces prepare automatically and repeated preparation does no extra cloud work or attendance writes',()=>fixture(async({db,api,pool,state})=>{
 const row=await api.prepareFace(pool,id(1),{site_id:10,emp_id:7});assert.equal(row.supervisor_face_ready,true);const count=state.indexed.length;
 assert.equal((await api.prepareFace(pool,id(1),{site_id:10,emp_id:7})).supervisor_face_ready,true);assert.equal(state.indexed.length,count);
 await assert.rejects(api.prepareFace(pool,id(4),{site_id:10,emp_id:7}),/outside/);assert.equal(state.indexed.length,count);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
}));

test('unusable saved photos are checked once then allow recapture without replacing legacy face references',()=>fixture(async({db,api,pool,state,enroll})=>{
 const before=(await db.query('SELECT * FROM employee WHERE emp_id=7')).rows[0];state.indexError=Object.assign(Error('Face is unclear. Capture a sharper photo.'),{status:422});
 let row=await api.prepareFace(pool,id(1),{site_id:10,emp_id:7});assert.equal(row.recapture_required,true);assert.equal(row.supervisor_face_ready,false);
 const count=state.indexed.length;await api.prepareFace(pool,id(1),{site_id:10,emp_id:7});assert.equal(state.indexed.length,count);
 state.indexError=null;await enroll(7);row=(await api.roster(pool,10)).find(p=>p.emp_id===7);assert.equal(row.supervisor_face_ready,true);assert.equal(row.recapture_required,false);
 assert.deepEqual((await db.query('SELECT * FROM employee WHERE emp_id=7')).rows[0],before);assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0);
}));

test('temporary provider failures stay retryable instead of authorizing a face replacement',()=>fixture(async({db,api,pool,state,enroll})=>{
 state.indexError=Object.assign(Error('Temporarily unavailable'),{status:503});
 await assert.rejects(api.prepareFace(pool,id(1),{site_id:10,emp_id:7}),/Temporarily/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM supervisor_attendance_face_checks')).rows[0].n,0);
 await assert.rejects(enroll(7),/saved photo/);
 state.indexError=null;assert.equal((await api.prepareFace(pool,id(1),{site_id:10,emp_id:7})).supervisor_face_ready,true);
}));

test('uncertain enrollment commit discards the connection and preserves committed face artifacts',()=>fixture(async({db,state,enroll,api,pool})=>{
 state.failCommitOnce=true;await assert.rejects(enroll(1),/Query read timeout/);
 assert.equal(state.releasedErrors.at(-1),'Query read timeout');assert.equal(state.queries.at(-1),'COMMIT','Never queue rollback or unlock on a driver-timed-out connection');
 assert.equal(state.deleted.length,0);assert.equal(state.deletedFaces.length,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM supervisor_attendance_faces')).rows[0].n,1);
 const indexed=state.indexed.length;assert.equal((await api.prepareFace(pool,id(1),{emp_id:1,site_id:10})).supervisor_face_ready,true);assert.equal(state.indexed.length,indexed);
}));

test('uncertain punch commit preserves evidence and a same-key retry returns the committed capture once',()=>fixture(async({db,state,enroll,punch})=>{
 await enroll(1);state.failCommitOnce=true;await assert.rejects(punch(),/Query read timeout/);
 assert.equal(state.releasedErrors.at(-1),'Query read timeout');assert.equal(state.queries.at(-1),'COMMIT');assert.equal(state.deleted.length,0);
 const result=await punch();assert.equal(result.replayed,true);assert.equal(result.marked,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int AS n FROM supervisor_attendance_captures')).rows[0].n,1);
}));

test('privacy migration removes only legacy copies of new capture references and preserves attendance and original evidence',()=>fixture(async({db,enroll,punch})=>{
 await enroll(1);await punch();const before=(await db.query('SELECT * FROM attendance WHERE emp_id=1')).rows[0];
 await db.query("UPDATE attendance SET punch_in_image='https://bucket.s3.amazonaws.com/new-private-photo' WHERE emp_id=1");
 await db.query("INSERT INTO attendance(emp_id,date,ward_id,punch_in_image) VALUES(2,current_date,10,'legacy-existing-photo')");
 await db.exec(fs.readFileSync('db/migrations/20261026_supervisor_attendance.sql','utf8'));
 const after=(await db.query('SELECT * FROM attendance WHERE emp_id=1')).rows[0];assert.deepEqual(after,before);
 assert.equal((await db.query('SELECT punch_in_image FROM attendance WHERE emp_id=2')).rows[0].punch_in_image,'legacy-existing-photo');
 assert.ok((await db.query('SELECT image_key FROM supervisor_attendance_captures WHERE id=$1',[before.supervisor_in_capture])).rows[0].image_key);
}));
