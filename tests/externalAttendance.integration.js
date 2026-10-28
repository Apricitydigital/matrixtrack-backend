// Local PostgreSQL fixture only; no live database, API keys or cloud requests.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {readImageAccess}=require('../utils/attendanceImageAccess');
const id=n=>`e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('external API returns complete scoped punch, supervisor, register and employee data',async()=>{
 const db=new PGlite(),previousSecret=process.env.JWT_SECRET;
 process.env.JWT_SECRET='local-external-api-test-secret';
 const signed=[];
 const sign=async key=>{signed.push(key);return `https://signed.example.test/${key}`;};
 const filename=path.join(__dirname,'../controllers/externalAttendanceReadController.js'),moduleRef={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:moduleRef,console,process,URL,require:name=>{
  if(name==='../config/db')return db;
  if(name==='../utils/s3SelfPunch')return {getSignedS3Url:sign};
  return require(require.resolve(name,{paths:[path.dirname(filename)]}));
 }});
 const ctrl=moduleRef.exports;
 async function call(name,query={},key={},params={}){
  const res={code:200,headers:{},status(code){this.code=code;return this;},set(k,v){this.headers[k]=v;return this;},json(body){this.body=body;return this;}};
  await ctrl[name]({query,params,apiKey:key},res);return res;
 }
 try{
  await db.exec(`CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);INSERT INTO cities VALUES(1,'One'),(2,'Two');
   CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT,zone_name TEXT);INSERT INTO zones VALUES(10,1,'Zone One'),(20,2,'Zone Two');
   CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,sector_id INT,ward_name TEXT);INSERT INTO wards VALUES(100,10,1000,'Site One'),(200,20,2000,'Site Two');
   CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);INSERT INTO department VALUES(1,'Regular'),(2,'Professional');
   CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT,department_id INT);INSERT INTO designation VALUES(1,'Guard',1),(2,'Project Head / Site Head',2);
   CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,email TEXT,role TEXT,is_deleted BOOLEAN,profile_photo_url TEXT,password TEXT);
   INSERT INTO users VALUES(9,'Legacy Supervisor','SUP9','9000000009','supervisor@example.test','supervisor',false,'supervisor.jpg','must-not-leak'),(10,'Other Supervisor','SUP10','9000000010','other@example.test','supervisor',false,NULL,'must-not-leak');
   CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,ward_id INT,designation_id INT,face_embedding TEXT,self_attendance_enabled BOOLEAN,no_personal_phone BOOLEAN,aadhar_no TEXT);
   INSERT INTO employee VALUES(1,'Face Employee','E1','9000000001',100,1,'face.jpg',false,false,'existing-private-field'),(2,'Register Employee','E2',NULL,100,1,NULL,false,true,NULL),(3,'Unmarked Employee','E3',NULL,100,1,NULL,false,true,NULL),(4,'Outside Employee','E4',NULL,200,1,NULL,false,true,NULL);
   CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,email TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,is_active BOOLEAN,selfie_url TEXT,password_hash TEXT);
   INSERT INTO professional_employees VALUES('${id(1)}','Project Head','P1','9111111111','head@example.test',1,10,1000,100,true,'head.jpg','must-not-leak'),('${id(2)}','Transferred Professional','P2','9222222222','professional@example.test',2,20,2000,200,true,NULL,'must-not-leak');
   CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);INSERT INTO professional_designation_assignments VALUES('${id(1)}',2);
   CREATE TABLE professional_site_access(professional_id UUID,kothi_id INT);INSERT INTO professional_site_access VALUES('${id(1)}',100),('${id(1)}',200);
   CREATE TABLE user_kothi_access(user_id INT,ward_id INT);INSERT INTO user_kothi_access VALUES(9,100),(9,200),(10,200);
   CREATE TABLE user_zone_access(user_id INT,zone_id INT);CREATE TABLE user_city_access(user_id INT,city_id INT);
   CREATE TABLE supervisor_kothi(supervisor_id INT,ward_id INT);INSERT INTO supervisor_kothi VALUES(9,100);
   CREATE TABLE supervisor_ward(supervisor_id INT,ward_id INT);
   CREATE TABLE supervisor_attendance_faces(emp_id INT PRIMARY KEY,site_id INT,photo_key TEXT,source_ref TEXT);
   INSERT INTO supervisor_attendance_faces VALUES(1,100,'enrolled-face.jpg','face.jpg');
   CREATE TABLE register_attendance_requests(id UUID,emp_id INT,site_id INT,status TEXT,starts_on DATE,ends_on DATE,created_at TIMESTAMPTZ);
   INSERT INTO register_attendance_requests VALUES('${id(90)}',2,100,'approved','2020-01-01','2100-01-01',NOW());
   CREATE TABLE supervisor_attendance_captures(id UUID PRIMARY KEY,image_key TEXT);
   INSERT INTO supervisor_attendance_captures VALUES('${id(30)}','group-in.jpg'),('${id(31)}','group-out.jpg');
   CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,ward_id INT,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,mid_shift_punch_in_time TIMESTAMPTZ,duration TEXT,leave_type TEXT,
    in_address TEXT,out_address TEXT,latitude_in FLOAT,longitude_in FLOAT,latitude_out FLOAT,longitude_out FLOAT,latitude_mid_in FLOAT,longitude_mid_in FLOAT,mid_in_address TEXT,auto_punched_out BOOLEAN,
    punch_in_image TEXT,punch_out_image TEXT,mid_shift_punch_in_image TEXT,punched_in_by INT,punched_out_by INT,mid_shift_punched_in_by INT,
    supervisor_in_by UUID,supervisor_out_by UUID,supervisor_in_name TEXT,supervisor_out_name TEXT,supervisor_in_capture UUID,supervisor_out_capture UUID,
    register_status TEXT,register_request_id UUID,register_marked_by UUID,register_marked_by_name TEXT,register_marked_at TIMESTAMPTZ);
   INSERT INTO attendance(attendance_id,emp_id,ward_id,date,punch_in_time,punch_out_time,mid_shift_punch_in_time,punch_in_image,punch_out_image,mid_shift_punch_in_image,punched_in_by,punched_out_by,mid_shift_punched_in_by,in_address,out_address,latitude_in,longitude_in)
    VALUES(1,1,100,'2026-10-28','2026-10-28 09:00','2026-10-28 18:00','2026-10-28 07:00Z','legacy-in.jpg','legacy-out.jpg','mid.jpg',9,9,9,'Entry gate','Exit gate',22.1,75.1);
   INSERT INTO attendance(attendance_id,emp_id,ward_id,date,punch_in_time,punch_out_time,supervisor_in_by,supervisor_out_by,supervisor_in_name,supervisor_out_name,supervisor_in_capture,supervisor_out_capture)
    VALUES(2,1,100,'2026-10-27','2026-10-27 09:00','2026-10-27 18:00','${id(1)}','${id(1)}','Head at capture','Head at capture','${id(30)}','${id(31)}');
   INSERT INTO attendance(attendance_id,emp_id,ward_id,date,register_status,register_request_id,register_marked_by,register_marked_by_name,register_marked_at)
    VALUES(3,2,100,'2026-10-28','present','${id(90)}','${id(1)}','Project Head','2026-10-28 09:00Z'),(4,2,100,'2026-10-27','absent','${id(90)}','${id(1)}','Project Head','2026-10-27 09:00Z');
   INSERT INTO attendance(attendance_id,emp_id,ward_id,date,punch_in_time) VALUES(5,4,200,'2026-10-28','2026-10-28 08:00');
   CREATE TABLE professional_attendance(id UUID PRIMARY KEY,professional_id UUID,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,attempted_punch_in TIMESTAMPTZ,punch_approval_status TEXT,auto_punched_out BOOLEAN,
    punch_in_latitude FLOAT,punch_in_longitude FLOAT,punch_out_latitude FLOAT,punch_out_longitude FLOAT,out_address TEXT,punch_in_photo_url TEXT,punch_out_photo_url TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT);
   INSERT INTO professional_attendance(id,professional_id,date,punch_in,punch_out,punch_approval_status,punch_in_photo_url,punch_out_photo_url,city_id,zone_id,ward_id,kothi_id)
    VALUES('${id(50)}','${id(2)}','2026-10-28','2026-10-28 03:30Z','2026-10-28 12:30Z','accepted','pro-in.jpg','pro-out.jpg',1,10,1000,100);`);
  const key={cityId:1,zoneId:10,wardId:100};
  let r=await call('getDailyAttendance',{date:'2026-10-28'},key);
  assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.data.length,2);
  const face=r.body.data.find(x=>x.emp_id===1),register=r.body.data.find(x=>x.emp_id===2);
  assert.equal(face.attendance_id,'1');assert.equal(face.punch_in,'09:00:00');assert.equal(face.mid_shift_punch_in,'12:30:00');
  assert.equal(face.in_address,'Entry gate');assert.equal(face.latitude_in,22.1);assert.equal(face.punched_in_by.id,'9');assert.equal(face.punched_in_by.type,'user');
  assert.equal(face.punched_in_by.photo_url,'https://signed.example.test/supervisor.jpg');
  assert.equal(face.punch_in_image,undefined);assert.equal(face.punched_in_by._photo,undefined);
  for(const [field,type] of [['punch_in_image_url','IN'],['punch_out_image_url','OUT'],['mid_shift_punch_in_image_url','MID_IN']]){
   const url=new URL(face[field]);assert.equal(url.origin,'https://api.matrixtrack.in');assert.equal(url.searchParams.get('punch_type'),type);
   assert.equal(readImageAccess(url.searchParams.get('image_access'),'1',type).punch_type,type);
   assert.throws(()=>readImageAccess(url.searchParams.get('image_access'),'5',type));
  }
  assert.equal(register.status,'Present');assert.equal(register.attendance_source,'register');assert.equal(register.punch_in,null);assert.equal(register.punch_in_image_url,null);
  assert.equal(register.register_request_id,id(90));assert.equal(register.register_actor.id,id(1));assert.equal(register.register_marked_by_name,'Project Head');
  r=await call('getAttendanceRange',{from:'2026-10-27',to:'2026-10-28',source:'supervisor'},key);
  assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.pagination.total,1);
  assert.equal(r.body.data[0].punch_in_image_url,'https://signed.example.test/group-in.jpg');assert.equal(r.body.data[0].punch_out_image_url,'https://signed.example.test/group-out.jpg');
  assert.equal(r.body.data[0].punched_in_by.type,'professional');assert.equal(r.body.data[0].punched_in_by_name,'Head at capture');
  r=await call('getEmployeeAttendance',{from:'2026-10-27',to:'2026-10-28'},key,{empId:'2'});
  assert.equal(r.body.data.length,2);assert.deepEqual(Array.from(r.body.data,x=>x.status),['Absent','Present']);
  r=await call('getAttendanceSummary',{date:'2026-10-28'},key);
  assert.equal(r.body.data.cities[0].total_present,2);assert.equal(r.body.data.cities[0].total_register_present,1);
  r=await call('getFullAttendance',{date:'2026-10-28',limit:2});assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.pagination.total,4);assert.equal(r.body.data.length,2);
  const firstIds=r.body.data.map(x=>x.employee_kind+':'+x.attendance_id);
  r=await call('getFullAttendance',{date:'2026-10-28',limit:2,page:2});assert.ok(r.body.data.every(x=>!firstIds.includes(x.employee_kind+':'+x.attendance_id)));
  r=await call('getProfessionalDailyAttendance',{date:'2026-10-28'},{cityId:2,wardId:200});
  assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].punch_in,'09:00:00');assert.equal(r.body.data[0].punch_out,'18:00:00');
  assert.equal(r.body.data[0].punch_in_image_url,'https://signed.example.test/pro-in.jpg');assert.equal(r.body.data[0].original_city_id,1);assert.equal(r.body.data[0].city_id,2);
  assert.equal((await call('getFullAttendance',{date:'2026-10-28',employee_type:'professional'},key)).body.data.length,0);
  signed.length=0;
  r=await call('getDailyAttendance',{date:'2026-10-28',city_id:2},key);assert.equal(r.body.data.length,0);assert.equal(signed.length,0,'Out-of-scope rows never receive photo links');
  r=await call('getEmployees',{},key);assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.data.length,3,'Registered roster includes employees with no attendance');
  const person=r.body.data.find(x=>x.emp_id===1),regPerson=r.body.data.find(x=>x.emp_id===2);
  assert.equal(person.face_image_url,'https://signed.example.test/enrolled-face.jpg');assert.equal(person.face_registered,true);assert.equal(person.supervisor_face_ready,true);
  assert.equal(person.supervisors.length,2,'Both legacy supervisor and project head included without assignment duplicates');
  assert.equal(regPerson.attendance_mode,'register');assert.equal(regPerson.no_personal_phone,true);
  assert.equal(person.face_embedding,undefined);assert.equal(person.aadhar_no,undefined);assert.equal(person._photo,undefined);
  r=await call('getEmployeeById',{},key,{empId:'1'});assert.equal(r.code,200);assert.equal(r.body.data.aadhar_no,'existing-private-field');
  assert.equal((await call('getEmployeeById',{},key,{empId:'4'})).code,404);
  r=await call('getSupervisors',{},key);assert.equal(r.code,200,JSON.stringify(r.body));assert.equal(r.body.data.length,2);
  assert.ok(r.body.data.every(x=>x.assignments.length===1 && x.assignments[0].city_id===1));
  assert.ok(r.body.data.every(x=>!('password' in x)&&!('password_hash' in x)&&!('_photo' in x)));
  for(const query of [{date:'2026-02-30'},{date:'2026-10-28',city_id:'1 OR true'},{date:'2026-10-28',limit:201},{date:'2026-10-28',source:'bad'},{date:'2026-10-28',employee_type:'bad'},{from:'2026-10-28',to:'2026-10-01'},{from:'2026-10-01',to:'2026-11-01'}])
   assert.equal((await call('getFullAttendance',query,key)).code,400,JSON.stringify(query));
 }finally{await db.close();if(previousSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previousSecret;}
});

test('full attendance and supervisor directory require existing API key read scopes',()=>{
 const routes=[],router={use:()=>{},get:(route,...handlers)=>routes.push({route,handlers}),post:()=>{},put:()=>{},delete:()=>{}};
 const file=path.join(__dirname,'../routes/externalApiRoutes.js');
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:{exports:{}},require:name=>{
  if(name==='express')return {Router:()=>router};if(name==='express-rate-limit')return ()=>()=>{};
  if(name==='../middleware/apiKeyAuth')return {apiKeyAuth:()=>{},requireScope:scope=>({scope})};
  if(name==='../controllers/externalApiController')return new Proxy({},{get:(_,key)=>key});throw Error(name);
 }});
 assert.equal(routes.find(x=>x.route==='/attendance/full').handlers[0].scope,'attendance:read');
 assert.equal(routes.find(x=>x.route==='/supervisors').handlers[0].scope,'employees:read');
});
