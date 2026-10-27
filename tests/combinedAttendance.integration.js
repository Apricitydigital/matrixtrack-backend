// In-memory PostgreSQL only. No .env, live database, migrations or AWS calls.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const {dateRange}=require('../utils/combinedAttendance');
const db=new PGlite();
const routes=[],middleware=[];
const router={use:(...handlers)=>middleware.push(...handlers)};
for(const verb of ['get','post'])router[verb]=(url,...handlers)=>routes.push({verb,url,handlers});
let checkedOut=0,failNextQuery=null,destroyed=0,rollbacks=0;
const pool={query:(sql,params)=>db.query(sql,params),connect:async()=>{checkedOut++;return {
 query:(sql,params)=>{if(failNextQuery){const error=failNextQuery;failNextQuery=null;return Promise.reject(error);}if(sql==='ROLLBACK')rollbacks++;return db.query(sql,params);},
 release(error){checkedOut--;if(error)destroyed++;}
};}};
const file=path.join(__dirname,'../routes/combinedAttendanceRoutes.js'),moduleRef={exports:{}};
const mocks={express:{Router:()=>router},'../config/db':pool,
 '../middleware/authMiddleware':(req,res,next)=>next(),
 '../middleware/cityScope':{attachCityScope:(req,res,next)=>next(),requireCityScope:()=> (req,res,next)=>next()},
 '../middleware/kothiScope':{attachKothiScope:(req,res,next)=>next()},
 '../middleware/permissionMiddleware':{authorize:(module)=>(req,res,next)=>req.denied===module?res.status(403).json({error:'Forbidden'}):next(),getPermissionCityFilter:(req,module)=>req.cities[module]},
 '../utils/s3SelfPunch':{getSignedS3Url:async key=>{assert.equal(checkedOut,0,'Photo signing must not hold a database connection');return `https://signed.example.test/${key}`;}}};
vm.runInNewContext(fs.readFileSync(file,'utf8'),{module:moduleRef,console,require:name=>mocks[name] || require(require.resolve(name,{paths:[path.dirname(file)]}))});
async function call(query={},options={}) {
 const req={query,body:{},user:{role:'admin',user_id:1},cityScope:{all:true,ids:[]},kothiScope:{all:true,ids:[]},cities:{attendance_reports:null,'professional-attendance':null},...options};
 const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 for(const handler of [...middleware,...routes.find(route=>route.verb==='post').handlers]){
  let next=false;await handler(req,res,()=>{next=true;});if(!next)break;
 }return res;
}
const id=n=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
(async()=>{
 await db.exec(`CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);INSERT INTO cities VALUES(1,'One'),(2,'Two');
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT,zone_name TEXT);INSERT INTO zones VALUES(1,1,'Zone One'),(2,2,'Zone Two');
 CREATE TABLE sectors(sector_id INT PRIMARY KEY,zone_id INT,sector_name TEXT);INSERT INTO sectors VALUES(100,1,'Sector One'),(200,2,'Sector Two');
 CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,sector_id INT,ward_name TEXT);INSERT INTO wards VALUES(10,1,100,'Site One'),(20,2,200,'Site Two');
 CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT);INSERT INTO users VALUES(1,'Admin'),(9,'Supervisor');
 CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);INSERT INTO department VALUES(1,'Regular'),(2,'Professional');
 CREATE TABLE designation(designation_id INT PRIMARY KEY,department_id INT,designation_name TEXT);INSERT INTO designation VALUES(1,1,'Guard'),(2,2,'Manager'),(3,2,'Coordinator');
 CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT,phone TEXT,ward_id INT,designation_id INT,face_embedding TEXT);
 INSERT INTO employee VALUES(1,'Same Person','SAME','9999999999',10,1,'face'),(2,'Absent Regular','REG2','9000000002',10,1,NULL),(3,'Elsewhere','REG3','9000000003',20,1,'face');
 CREATE TABLE attendance(attendance_id SERIAL PRIMARY KEY,emp_id INT,ward_id INT,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,
 mid_shift_punch_in_time TIMESTAMPTZ,leave_type TEXT,punched_in_by INT,punched_out_by INT,mid_shift_punched_in_by INT,auto_punched_out BOOLEAN);
 INSERT INTO attendance(emp_id,ward_id,date,punch_in_time,punch_out_time,punched_in_by,punched_out_by) VALUES(1,10,'2026-10-21','2026-10-21 09:00','2026-10-21 18:00',9,9);
 CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,mobile TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,is_active BOOLEAN,selfie_url TEXT);
 CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT);
 CREATE TABLE professional_attendance(id UUID PRIMARY KEY,professional_id UUID,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,attempted_punch_in TIMESTAMPTZ,punch_approval_status TEXT,
 auto_punched_out BOOLEAN,out_address TEXT,punch_in_latitude DOUBLE PRECISION,punch_in_longitude DOUBLE PRECISION,punch_out_latitude DOUBLE PRECISION,punch_out_longitude DOUBLE PRECISION,
 punch_in_photo_url TEXT,punch_out_photo_url TEXT,ward_id INT,city_id INT,zone_id INT,kothi_id INT);
 CREATE TABLE professional_leave_requests(id UUID PRIMARY KEY,professional_id UUID,requested_date DATE,leave_type TEXT,status TEXT,requested_at TIMESTAMPTZ,reviewed_at TIMESTAMPTZ,review_note TEXT,reviewed_by INT,pm_reviewer_id UUID,ho_reviewer_id UUID,hod_reviewer_id UUID);
 CREATE TABLE user_city_access(user_id INT,city_id INT);CREATE TABLE user_zone_access(user_id INT,zone_id INT);CREATE TABLE user_kothi_access(user_id INT,ward_id INT);
 CREATE TABLE supervisor_kothi(supervisor_id INT,ward_id INT);CREATE TABLE supervisor_ward(supervisor_id INT,ward_id INT);
 INSERT INTO user_kothi_access VALUES(9,10);`);
 for(let n=1;n<=8;n++)await db.query(`INSERT INTO professional_employees VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,'face')`,[id(n),n===1?'Same Person':`Professional ${n}`,n===1?'SAME':`PRO${n}`,n===1?'9999999999':`988888888${n}`,n===2?2:1,n===2?200:100,n===2?20:10,n<7]);
 await db.query('INSERT INTO professional_designation_assignments VALUES($1,2),($1,3)',[id(1)]);
 for(const n of [1,2,3,4,7])await db.query(`INSERT INTO professional_attendance(id,professional_id,date,punch_in,punch_out,attempted_punch_in,punch_approval_status,auto_punched_out,punch_in_photo_url,city_id,ward_id,zone_id,kothi_id)
 VALUES($1,$2,'2026-10-21',$3,$4,$5,$6,$7,$8,$9,$10,$9,$11)`,[id(100+n),id(n),[3,4].includes(n)?null:'2026-10-21T09:00:00+05:30',[3,4].includes(n)?null:'2026-10-21T18:00:00+05:30',[3,4].includes(n)?'2026-10-21T10:00:00+05:30':null,n===3?'pending_pm':n===4?'rejected':'accepted',n===1,n===1?'professional-photo.jpg':null,n===2?2:1,n===2?200:100,n===2?20:10]);
 await db.query("INSERT INTO professional_leave_requests(id,professional_id,requested_date,leave_type,status) VALUES($1,$2,'2026-10-21','CASUAL','approved')",[id(200),id(5)]);
 const query={date:'2026-10-21'};
 let r=await call(query);assert.equal(r.code,200,JSON.stringify(r.body));
 assert.equal(r.body.employees.length,10,'3 regular + 7 professional active/historical employees');
 assert.equal(r.body.records.length,7,'regular attendance + professional punches/attempts + approved leave');
 assert.equal(r.body.employees.filter(e=>e.emp_code==='SAME').length,2,'Same code/mobile do not silently merge distinct identities');
 const pro=r.body.records.find(row=>row.emp_id===`professional:${id(1)}`);
 assert.equal(pro.punch_in,'09:00:00');assert.equal(pro.punch_out,'18:00:00');assert.equal(pro.is_auto_punch_out,true);assert.equal(pro.punch_in_image_url,'https://signed.example.test/professional-photo.jpg');
 assert.deepEqual(Array.from(pro.designation_ids),[2,3]);assert.equal(pro.punched_in_by,'Same Person');
 assert.equal(r.body.records.find(row=>row.emp_id==='1').punched_in_by,'Supervisor');
 assert.equal(r.body.records.find(row=>row.emp_id===`professional:${id(3)}`).punch_in,null);
 assert.equal(r.body.records.find(row=>row.emp_id===`professional:${id(3)}`).attendance_status,'in-consideration');
 assert.equal(r.body.records.find(row=>row.emp_id===`professional:${id(4)}`).attendance_status,'punch-not-accepted');
 assert.equal(r.body.records.find(row=>row.emp_id===`professional:${id(5)}`).leave_type,'CASUAL');
 assert.ok(!r.body.employees.some(row=>row.source_employee_id===id(8)),'Inactive accounts without historical records are excluded');
 assert.equal((await call({...query,employeeType:'regular'})).body.records.length,1);
 assert.equal((await call({...query,employeeType:'professional'})).body.records.length,6);
 r=await call(query,{cities:{attendance_reports:[1],'professional-attendance':[2]}});assert.equal(r.code,200);
 assert.equal(r.body.employees.filter(row=>row.employee_kind==='regular').length,2);assert.equal(r.body.employees.filter(row=>row.employee_kind==='professional').length,1);
 r=await call(query,{kothiScope:{all:false,ids:[10]}});assert.ok(r.body.employees.every(row=>row.ward_id===10));
 r=await call(query,{kothiScope:{all:false,ids:[]}});assert.equal(r.body.employees.length,0);
 r=await call(query,{user:{role:'supervisor',user_id:9},cityScope:{all:false,ids:[1]},cities:{attendance_reports:[1],'professional-attendance':[1]},kothiScope:{all:false,ids:[10]}});assert.equal(r.code,200,JSON.stringify(r.body));assert.ok(r.body.employees.every(row=>row.ward_id===10));
 assert.equal((await call(query,{denied:'professional-attendance'})).code,403);
 assert.equal((await call({...query,employeeType:'regular'},{denied:'professional-attendance'})).code,200);
 assert.equal((await call(query,{denied:'attendance_reports'})).code,403);
 assert.equal((await call({...query,employeeType:'bad'})).code,400);
 for(const bad of [{date:'2026-02-30'},{date:'2026-99-01'},{startDate:'2026-10-22',endDate:'2026-10-21'},{startDate:'2020-01-01',endDate:'2026-10-21'}])assert.equal((await call(bad)).code,400);
 assert.deepEqual(dateRange({startDate:'2026-10-20',endDate:'2026-10-21'}),{start:'2026-10-20',end:'2026-10-21'});
 for(const date of [['2026-10-21'],{},42])assert.equal((await call({date})).code,400);
 assert.equal((await call({startDate:'2025-01-01',endDate:'2026-01-02'})).code,400,'More than 366 inclusive days is rejected');
 r=await call({startDate:'2026-10-20',endDate:'2026-10-22'});assert.equal(r.body.records.length,7);
 const rollbackCount=rollbacks;
 failNextQuery=new Error('Query read timeout');
 assert.equal((await call(query)).code,500);assert.equal(destroyed,1);assert.equal(checkedOut,0);
 assert.equal(rollbacks,rollbackCount,'Driver timeout must not queue a rollback');
 assert.equal((await call(query)).code,200,'Following request can use a clean connection');
 await db.query('UPDATE employee SET ward_id=20 WHERE emp_id=1');
 await db.query('UPDATE professional_employees SET city_id=2,zone_id=2,ward_id=200,kothi_id=20 WHERE id=$1',[id(1)]);
 r=await call(query,{cityScope:{all:false,ids:[1]},cities:{attendance_reports:[1],'professional-attendance':[1]},kothiScope:{all:false,ids:[10]}});
 assert.equal(r.code,200,JSON.stringify(r.body));
 for(const employeeId of ['1',`professional:${id(1)}`]){
  const history=r.body.records.find(row=>row.emp_id===employeeId);
  assert.ok(history,'Transfer must not hide attendance from the former site');assert.equal(history.ward_id,10);assert.equal(history.city_id,1);
  const person=r.body.employees.find(row=>row.emp_id===employeeId);assert.equal(person.ward_id,10);
  assert.ok(person.report_locations.every(location=>location.city_id===1),'Unapproved current location must not leak');
 }
 await db.query('UPDATE professional_attendance SET kothi_id=NULL WHERE professional_id=$1',[id(3)]);
 r=await call(query);const legacy=r.body.records.find(row=>row.emp_id===`professional:${id(3)}`);
 assert.equal(legacy.ward,'Site not recorded');assert.equal(legacy.ward_id,null);assert.equal(legacy.historical_site_unknown,true);
 r=await call({...query,cityId:'2',kothiIds:'20'});assert.ok(r.body.records.every(row=>row.city_id===2 && row.ward_id===20));
 assert.equal((await call({...query,kothiIds:'invalid'})).code,400);
 await db.exec(`CREATE TABLE supervisor_attendance_captures(id UUID PRIMARY KEY,image_key TEXT);
 INSERT INTO supervisor_attendance_captures VALUES('${id(900)}','supervisor-attendance/private-group.jpg');
 ALTER TABLE attendance ADD COLUMN supervisor_in_by UUID,ADD COLUMN supervisor_in_name TEXT,ADD COLUMN supervisor_in_capture UUID,ADD COLUMN register_status TEXT,ADD COLUMN register_marked_by_name TEXT;
 UPDATE attendance SET supervisor_in_by='${id(1)}',supervisor_in_name='Project Head',supervisor_in_capture='${id(900)}' WHERE emp_id=1;
 INSERT INTO attendance(emp_id,ward_id,date,register_status,register_marked_by_name) VALUES(2,10,'2026-10-21','present','Site Head');`);
 r=await call(query);const faceRow=r.body.records.find(row=>row.emp_id==='1');assert.equal(faceRow.attendance_source,'supervisor');assert.equal(faceRow.punched_in_by,'Project Head');assert.equal(faceRow.supervisor_in_capture,id(900));assert.equal(faceRow.punch_in,'09:00:00');assert.equal(faceRow.punch_in_image_url,'https://signed.example.test/supervisor-attendance/private-group.jpg');
 const manualRow=r.body.records.find(row=>row.emp_id==='2');assert.equal(manualRow.attendance_source,'register');assert.equal(manualRow.register_status,'present');assert.equal(manualRow.punch_in,null);assert.equal(manualRow.register_marked_by_name,'Site Head');
 console.log('PASS: default combined population, type filters, stable identities, IST punches/photos, regular actor names, supervisor/Register source and evidence, multi-designations, leave/pending/rejection, historical inactive rows, separate permission scopes, site/supervisor access and date validation.');
 await db.close();
})().catch(async error=>{console.error(error);await db.close();process.exitCode=1;});
