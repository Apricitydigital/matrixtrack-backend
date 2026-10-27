const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function fixture(run){
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT);
   INSERT INTO wards VALUES(10,'Site A'),(20,'Site B');
   CREATE TABLE employee(emp_id SERIAL PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT NOT NULL,ward_id INT REFERENCES wards, self_attendance_enabled BOOLEAN DEFAULT FALSE,face_embedding TEXT);
   CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,is_active BOOLEAN DEFAULT TRUE);
   CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT);
   INSERT INTO designation VALUES(1,'Project Head / Site Head'),(2,'HO Coordinator'),(3,'Head of Department');
   CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);
   CREATE TABLE professional_site_access(professional_id UUID,kothi_id INT);
   CREATE TABLE professional_notifications(id UUID DEFAULT gen_random_uuid(),professional_id UUID,type TEXT,title TEXT,message TEXT,metadata JSONB);
   CREATE TABLE attendance(attendance_id SERIAL PRIMARY KEY,emp_id INT REFERENCES employee,date DATE,ward_id INT REFERENCES wards,
    punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,punch_in_image TEXT,punch_out_image TEXT,mid_shift_punch_in_time TIMESTAMPTZ,leave_type TEXT,UNIQUE(emp_id,date));`);
  await db.exec(fs.readFileSync('db/migrations/20261026_register_attendance.sql','utf8'));
  await db.exec(fs.readFileSync('db/migrations/20261026_register_attendance.sql','utf8'));
  await db.exec(fs.readFileSync('db/migrations/20261026_supervisor_attendance.sql','utf8'));
  for(let n=1;n<=6;n++){
   await db.query('INSERT INTO professional_employees VALUES($1,$2,$3,TRUE)',[id(n),'Reviewer '+n,'P'+n]);
   await db.query('INSERT INTO professional_site_access VALUES($1,$2)',[id(n),n===4?20:10]);
   await db.query('INSERT INTO professional_designation_assignments VALUES($1,$2)',[id(n),n===2?2:n===3?3:n===6?2:1]);
  }
  await db.query('INSERT INTO professional_designation_assignments VALUES($1,3)',[id(6)]);
  for(let n=1;n<=8;n++)await db.query('INSERT INTO employee(name,emp_code,phone,ward_id,no_personal_phone) VALUES($1,$2,NULL,$3,TRUE)',['Worker '+n,'E'+n,n===8?20:10]);
  const module={exports:{}};const caps={exports:{}};
  vm.runInNewContext(fs.readFileSync('utils/professionalPunchCutoff.js','utf8'),{module:caps,require:name=>name==='fs'?fs:name==='path'?require('node:path'):db});
  vm.runInNewContext(fs.readFileSync('utils/registerAttendance.js','utf8'),{module,require:()=>caps.exports});
  const api=module.exports;
  const tx=async fn=>{await db.exec('BEGIN');try{const r=await fn();await db.exec('COMMIT');return r;}catch(e){await db.exec('ROLLBACK');throw e;}};
  const request=(emp=1,days=30,actor=id(1))=>tx(()=>api.requestPermission(db,actor,{emp_id:emp,duration_days:days,reason:'No phone; remote work site'}));
  const review=(r,actor,decision='approve',note='')=>tx(()=>api.reviewPermission(db,actor,r.id,{decision,note}));
  const approve=async(emp=1,days=30)=>{let r=await request(emp,days);r=await review(r,id(2));return review(r,id(3));};
  const mark=(emp=1,status='present',actor=id(1),date)=>tx(()=>api.markAttendance(db,actor,{emp_id:emp,status,date}));
  const routes={exports:{}};
  const pool={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
  const deps={'express':require('express'),'../config/db':pool,'../middleware/professionalAuth':(req,res,next)=>req.professional?next():res.status(401).json({message:'Sign in'}),'../utils/professionalPunchCutoff':caps.exports,'../utils/registerAttendance':api,'../utils/employeeAttendanceMode':require('../utils/employeeAttendanceMode')};
  vm.runInNewContext(fs.readFileSync('routes/registerAttendanceRoutes.js','utf8'),{module:routes,console,require:name=>deps[name]});
  const call=(method,url,actor=id(1),body={})=>new Promise((resolve,reject)=>{
   const req={method,url,query:{},body,headers:{},professional:actor?{professional_id:actor}:null};
   const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({code:this.statusCode,...data});return this;}};
   routes.exports.handle(req,res,error=>error?reject(error):resolve({code:404}));
  });
  await run({db,api,tx,request,review,approve,mark,call});
 }finally{await db.close();}
}
test('normal employee registration without a phone, HO then HOD approval, marking and report provenance',()=>fixture(async({db,api,request,review,mark})=>{
 const before=(await db.query('SELECT * FROM employee WHERE emp_id=1')).rows[0];assert.equal(before.phone,null);assert.equal(before.no_personal_phone,true);
 const today=await api.today(db);let r=await request();assert.equal(r.duration_days,30);assert.equal(r.status,'pending_ho');
 await assert.rejects(mark(),/No active/);await assert.rejects(review(r,id(3)),/cannot review/);
 r=await review(r,id(2));assert.equal(r.status,'pending_hod');await assert.rejects(mark(),/No active/);
 r=await review(r,id(3));assert.equal(r.status,'approved');
 const dates=(await db.query('SELECT starts_on::text,ends_on::text,ends_on-starts_on+1 AS days FROM register_attendance_requests')).rows[0];assert.equal(dates.starts_on,today);assert.equal(dates.days,30);
 const row=await mark();assert.equal(row.register_status,'present');assert.equal(row.punch_in_time,null);assert.equal(row.punch_out_time,null);assert.equal(row.register_marked_by_name,'Reviewer 1');
 const normalized=require('../utils/combinedAttendance').normalizeReport([{emp_id:'1',employee_kind:'regular',name:'Worker 1',entries:[{date:today,record:row}],current_assignment_visible:true}]);
 assert.equal(normalized.records[0].register_status,'present');assert.equal(normalized.records[0].attendance_source,'register');assert.equal(normalized.records[0].punch_in,null);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM register_attendance_audit')).rows[0].n,4);
 assert.deepEqual((await db.query('SELECT * FROM employee WHERE emp_id=1')).rows[0],before);
}));
test('only assigned Project Head requests and marks; approval cannot be self-reviewed or performed twice',()=>fixture(async({db,request,review,approve,mark})=>{
 await assert.rejects(request(8),/outside/);await assert.rejects(request(1,30,id(2)),/Project Head/);
 const r=await request();await assert.rejects(request(),/already exists/);await assert.rejects(review(r,id(1)),/different reviewer/);
 await assert.rejects(review(r,id(4)),/cannot review/);
 await review(r,id(2));await assert.rejects(review(r,id(2)),/different reviewer/);
 await review(r,id(3));await assert.rejects(review(r,id(3)),/already been reviewed/);
 await assert.rejects(mark(1,'present',id(5)),/No active/);await assert.rejects(mark(1,'present',id(4)),/outside/);
 await db.query('DELETE FROM professional_site_access WHERE professional_id=$1',[id(1)]);await assert.rejects(mark(),/outside/);
}));
test('duration limits, rejected requests, expiry, and backdating are enforced by database time',()=>fixture(async({db,api,request,review,approve,mark})=>{
 for(const days of [0,31,1.5,'1',null])await assert.rejects(request(1,days),/1–30/);
 let r=await request(1,1);await assert.rejects(review(r,id(2),'reject'),/rejection reason/);r=await review(r,id(2),'reject','Phone available');assert.equal(r.status,'rejected');await assert.rejects(mark(),/No active/);
 r=await approve(1,1);assert.equal((await db.query('SELECT ends_on-starts_on AS n FROM register_attendance_requests WHERE id=$1',[r.id])).rows[0].n,0);
 await assert.rejects(mark(1,'present',id(1),'2000-01-01'),/Only today/);
 await db.query("UPDATE register_attendance_requests SET starts_on=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-1,ends_on=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-1 WHERE id=$1",[r.id]);
 await assert.rejects(mark(),/No active/);assert.equal((await request(1,7)).status,'pending_ho');
}));
test('manual absence is retained and existing punches, leaves and register marks cannot be overwritten',()=>fixture(async({db,api,approve,mark})=>{
 const today=await api.today(db);await approve(1);const absent=await mark(1,'absent');assert.equal(absent.register_status,'absent');await assert.rejects(mark(1,'present'),/already marked/);
 await approve(2);await db.query('INSERT INTO attendance(emp_id,date,ward_id,punch_in_time) VALUES(2,$1,10,$2)',[today,today+' 09:00:00']);await assert.rejects(mark(2),/already marked/);
 await approve(3);await db.query("INSERT INTO attendance(emp_id,date,ward_id,leave_type) VALUES(3,$1,10,'CL')",[today]);await assert.rejects(mark(3),/already marked/);
 await approve(4);await db.query('INSERT INTO attendance(emp_id,date,ward_id) VALUES(4,$1,10)',[today]);assert.equal((await mark(4)).register_status,'present');
 await assert.rejects(db.query('UPDATE attendance SET punch_in_time=$1 WHERE emp_id=1',[today+' 09:00:00']),/attendance_register_evidence/);
}));
test('site transfer, missing approval roles and professional employees cannot bypass the workflow',()=>fixture(async({db,request,review,approve,mark})=>{
 const r=await request(1);await db.query('UPDATE employee SET ward_id=20 WHERE emp_id=1');await assert.rejects(review(r,id(2)),/site changed/);
 await approve(2);await db.query('UPDATE employee SET ward_id=20 WHERE emp_id=2');await assert.rejects(mark(2),/outside/);
 await db.query("UPDATE employee SET emp_code='P1' WHERE emp_id=3");await assert.rejects(request(3),/regular employee/);
 await db.query("DELETE FROM professional_designation_assignments WHERE designation_id=3");await assert.rejects(request(4),/different HO and HOD/);
}));
test('regular employee team attendance includes manual present and absent without fake punch times',()=>fixture(async({db,api,approve,mark})=>{
 await approve(1);await mark(1,'present');await approve(2);await mark(2,'absent');
 const today=await api.today(db),query=require('../utils/regularTeamAttendance').regularTeamAttendanceQuery([id(1),today.slice(0,7)+'-01',null,today,'',today,0]);
 const result=(await db.query(query.sql,query.params)).rows[0];
 const present=result.data.find(r=>r.employee_id==='1'),absent=result.data.find(r=>r.employee_id==='2');
 assert.equal(present.status,'present');assert.equal(present.attendance_source,'register');assert.equal(present.punch_in,null);assert.equal(absent.status,'absent');assert.equal(result.summary.present,1);assert.ok(!result.data.some(r=>r.employee_id==='8'));
}));

test('authenticated API lists requests by site and role, exposes active markings and expires them automatically',()=>fixture(async({db,call})=>{
 assert.equal((await call('GET','/',null)).code,401);
 let response=await call('POST','/requests',id(1),{emp_id:1,reason:'No phone; remote site'});assert.equal(response.code,201);const request=response.data;
 response=await call('GET','/');assert.equal(response.code,200);assert.equal(response.capabilities.request,true);assert.equal(response.data.length,1);assert.ok(response.employees.some(e=>e.emp_id===1));
 assert.equal((await call('GET','/',id(4))).data.length,0);
 response=await call('GET','/',id(2));assert.equal(response.data[0].can_review,true);assert.equal(response.capabilities.request,false);
 await call('POST',`/requests/${request.id}/review`,id(2),{decision:'approve'});
 response=await call('GET','/',id(2));assert.equal(response.data[0].can_review,false);
 response=await call('POST',`/requests/${request.id}/review`,id(3),{decision:'approve'});assert.equal(response.code,200);
 response=await call('GET','/');assert.equal(response.employees.find(e=>e.emp_id===1).approval_id,request.id);
 response=await call('POST','/mark',id(1),{emp_id:1,status:'absent'});assert.equal(response.code,201);
 response=await call('GET','/');assert.equal(response.employees.find(e=>e.emp_id===1).register_status,'absent');
 await db.query("UPDATE register_attendance_requests SET starts_on=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-31,ends_on=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date-2 WHERE id=$1",[request.id]);
 response=await call('GET','/');assert.equal(response.data[0].display_status,'expired');assert.equal(response.employees.find(e=>e.emp_id===1).approval_id,null);
}));
