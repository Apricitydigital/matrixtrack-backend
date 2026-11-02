const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
function load(relative,deps){const module={exports:{}};vm.compileFunction(fs.readFileSync(path.join(__dirname,'..',relative),'utf8'),['require','module','console'],{filename:relative})(name=>{assert.ok(Object.hasOwn(deps,name),name);return deps[name];},module,console);return module.exports;}
async function fixture(run){const db=new PGlite();try{
 await db.exec(`CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);INSERT INTO cities VALUES(1,'City A'),(2,'City B');
 CREATE TABLE zones(zone_id INT PRIMARY KEY,zone_name TEXT,city_id INT);INSERT INTO zones VALUES(10,'Zone A',1),(20,'Zone B',2);
 CREATE TABLE sectors(sector_id INT PRIMARY KEY,sector_name TEXT);INSERT INTO sectors VALUES(1001,'Overlapping old Sector');
 CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT,zone_id INT,sector_id INT);INSERT INTO wards VALUES(1001,'Physical A',10,NULL),(1002,'Physical B',10,NULL),(2001,'Physical C',20,NULL);
 CREATE TABLE users(user_id INT PRIMARY KEY,name TEXT,phone TEXT,role TEXT,permissions JSONB);
 INSERT INTO users VALUES(1,'Full admin','1','admin',NULL),(2,'City reader','2','admin','{"modules":{"supervisor_audit":"view"}}'),(3,'Denied','3','admin','{"modules":{}}'),(4,'Ward reader','4','admin','{"modules":{"supervisor_audit":"view"}}'),(11,'Supervisor A','11','supervisor',NULL),(12,'Supervisor B','12','supervisor',NULL);
 CREATE TABLE supervisor_ward(supervisor_id INT,ward_id INT);INSERT INTO supervisor_ward VALUES(11,1001),(11,1002),(12,2001);
 CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);INSERT INTO department VALUES(1,'Operations');
 CREATE TABLE designation(designation_id INT PRIMARY KEY,department_id INT);INSERT INTO designation VALUES(1,1);
 CREATE TABLE employee(emp_id INT PRIMARY KEY,ward_id INT,designation_id INT);INSERT INTO employee VALUES(1,1001,1),(2,1002,1),(3,2001,1);
 CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,ward_id INT,date DATE,punched_in_by INT,punched_out_by INT,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,mid_shift_punch_in_time TIMESTAMP,leave_type TEXT,auto_punched_out BOOLEAN);
 INSERT INTO attendance VALUES(1,1,1001,'2026-10-31',11,11,'2026-10-31 09:00','2026-10-31 17:00',NULL,NULL,FALSE),(2,2,1002,'2026-10-31',11,NULL,'2026-10-31 09:00',NULL,NULL,NULL,FALSE),(3,3,2001,'2026-10-31',12,NULL,'2026-10-31 09:00',NULL,NULL,NULL,FALSE);`);
 const pool={query:(sql,params)=>db.query(sql,params)};
 const scope=user=>({all:user.user_id===1,ids:user.user_id===1?[]:[1]});
 const permissions=load('middleware/permissionMiddleware.js',{'../config/db':pool,'../utils/userCityAccess':{fetchUserCityAccess:async user=>scope(user),invalidateCityAccessCache(){}}});
 const city={attachCityScope:(req,res,next)=>{req.cityScope=scope(req.user);next();},requireCityScope:()=> (req,res,next)=>next(),buildCityFilterClause:()=>({clause:'',params:[]})};
 const ward={attachKothiScope:(req,res,next)=>{req.kothiScope=req.user.user_id===1?{all:true,ids:[]}:{all:false,ids:req.user.user_id===4?[1002]:[1001,1002]};next();},buildKothiFilterClause:()=>({clause:'',params:[]})};
 const auth=(req,res,next)=>req.user?.user_id?next():res.status(401).json({error:'No session'});
 const deps={express:require('express'),'../config/db':pool,'../middleware/authMiddleware':auth,'../middleware/cityScope':city,'../middleware/kothiScope':ward,'../middleware/permissionMiddleware':permissions,'../utils/attendanceReportDownload':{createAttendanceDownloadHandler:()=>()=>{}}};
 const request=(router,user_id,url='/',query={})=>new Promise((resolve,reject)=>router.handle({method:'GET',url,user:{user_id,role:'super_admin'},query},{code:200,status(n){this.code=n;return this;},json(body){resolve({code:this.code,body});return this;}},error=>reject(error||Error('Route not found'))));
 await run({db,load:relative=>load(relative,deps),request});
 }finally{await db.close();}}
test('Supervisor Audit uses physical Ward/Zone/City with NULL Sector and enforces view plus City/Ward scope',()=>fixture(async({load,request})=>{
 const router=load('routes/supervisorAuditRoutes.js'),query={startDate:'2026-10-31',endDate:'2026-10-31'};
 let result=await request(router,1,'/',query);assert.equal(result.code,200);assert.equal(result.body.length,3);
 const a=result.body.find(r=>r.ward_id===1001);assert.equal(a.ward_name,'Physical A');assert.equal(a.kothi_name,'Physical A');assert.equal(a.city_name,'City A');assert.equal(a.zone_name,'Zone A');assert.equal(a.supervisor_id,11);assert.equal(Number(a.total_punch_in),1);
 result=await request(router,2,'/',query);assert.equal(result.code,200);assert.deepEqual(result.body.map(r=>r.ward_id),[1001,1002]);
 result=await request(router,4,'/',query);assert.deepEqual(result.body.map(r=>r.ward_id),[1002]);
 assert.equal((await request(router,3,'/',query)).code,403,'Forged role claim cannot bypass actual missing view permission');
 assert.equal((await request(router,null,'/',query)).code,401);
 assert.deepEqual((await request(router,2,'/',{...query,wardId:2001})).body,[]);
 assert.deepEqual((await request(router,1,'/',{...query,wardId:1002})).body.map(r=>r.ward_id),[1002]);
}));
test('Short Attendance returns physical Ward labels/IDs and cannot bypass assigned Ward scope',()=>fixture(async({load,request})=>{
 const router=load('routes/attendanceRoutes.js'),query={cityName:'City A',date:'2026-10-31'};
 let result=await request(router,1,'/short-report',query);assert.equal(result.code,200);assert.deepEqual(result.body.map(r=>[r.ward_id,r.ward_name,r.kothi_name]),[[1001,'Physical A','Physical A'],[1002,'Physical B','Physical B']]);
 result=await request(router,4,'/short-report',query);assert.equal(result.code,200);assert.deepEqual(result.body.map(r=>r.ward_id),[1002]);
 result=await request(router,4,'/short-report',{...query,kothiId:'1001'});assert.deepEqual(result.body,[],'Explicit physical IDs cannot expand assigned scope');
 result=await request(router,1,'/short-report',{...query,kothiId:'1001'});assert.equal(result.body.length,1);assert.equal(Number(result.body[0].total_registered_employees),1);assert.equal(Number(result.body[0].total_present_employees),1);
}));
