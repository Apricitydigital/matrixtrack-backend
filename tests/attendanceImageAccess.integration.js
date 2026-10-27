const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),jwt=require('jsonwebtoken');
const {PGlite}=require('@electric-sql/pglite');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(run){const db=new PGlite(),old=process.env.JWT_SECRET;process.env.JWT_SECRET='isolated-image-access-test';try{
 await db.exec(`CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(1,1),(2,2);
 CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT);INSERT INTO wards VALUES(10,1),(20,2);
 CREATE TABLE users(user_id INT PRIMARY KEY,role TEXT,emp_code TEXT,is_active BOOLEAN);INSERT INTO users VALUES(1,'admin',NULL,TRUE),(2,'supervisor',NULL,TRUE),(3,'supervisor',NULL,TRUE),(4,'employee','E1',TRUE),(5,'supervisor',NULL,FALSE),(6,'supervisor',NULL,TRUE);
 CREATE TABLE employee(emp_id INT PRIMARY KEY,emp_code TEXT,ward_id INT,self_attendance_enabled BOOLEAN);INSERT INTO employee VALUES(1,'E1',10,TRUE),(2,'E2',20,TRUE);
 CREATE TABLE attendance(attendance_id UUID PRIMARY KEY,emp_id INT,ward_id INT,punch_in_image TEXT,punch_out_image TEXT,mid_shift_punch_in_image TEXT);
 INSERT INTO attendance VALUES('${id(101)}',1,10,'private-in','private-out','private-mid'),('${id(102)}',2,20,'outside-in',NULL,NULL);
 CREATE TABLE active_sessions(token_hash TEXT,is_revoked BOOLEAN);`);
 const tokens=new Map();for(let n=1;n<=6;n++)tokens.set(n,jwt.sign({user_id:n},process.env.JWT_SECRET));
 await db.query('INSERT INTO active_sessions VALUES($1,TRUE)',[crypto.createHash('sha256').update(tokens.get(6)).digest('hex')]);
 let reads=0,unavailable=false;const pool={query:async(sql,p)=>{reads++;if(unavailable&&sql.includes('active_sessions'))throw Error('Unavailable');return db.query(sql,p);}};
 const access=require('../utils/attendanceImageAccess');const module={exports:{}};
 const deps={'../config/db':pool,'node:crypto':crypto,'../utils/attendanceImageAccess':access,'./authMiddleware':(req,res,next)=>{try{req.user=jwt.verify(req.headers.authorization.replace(/^Bearer /,''),process.env.JWT_SECRET);return next();}catch(_){res.status(401).json({error:'Login required'});}},'./kothiScope':{attachKothiScope:(req,res,next)=>{req.kothiScope={all:req.user.user_id===1,ids:[req.user.user_id===3?20:10]};return next();}},'./cityScope':{attachCityScope:(req,res,next)=>{req.cityScope={all:req.user.user_id===1,ids:[req.user.user_id===3?2:1]};return next();}},'./permissionMiddleware':{authorize:()=> (req,res,next)=>req.user.role==='admin'?next():res.status(403).json({error:'Denied'})}};
 vm.runInNewContext(fs.readFileSync('middleware/attendanceImageGuard.js','utf8'),{module,require:n=>deps[n]});
 const call=(actor=2,query={},path='/app/attendance/employee/image')=>new Promise((resolve,reject)=>{
  const req={method:'GET',path,query:{attendance_id:id(101),punch_type:'IN',...query},headers:actor?{authorization:'Bearer '+tokens.get(actor)}:{},cookies:{}};
  const res={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(body){resolve({code:this.statusCode,body});}};
  Promise.resolve(module.exports(req,res,()=>resolve({code:200,passed:true}))).catch(reject);
 });
 await run({db,call,access,tokens,reads:()=>reads,setUnavailable:v=>{unavailable=v;}});
 }finally{if(old===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=old;await db.close();}}
test('photo access requires authentication and current site/city scope, while self users see only their own image',()=>fixture(async({call})=>{
 assert.equal((await call(null)).code,401);assert.equal((await call(2)).passed,true);assert.equal((await call(3)).code,403);assert.equal((await call(4)).passed,true);assert.equal((await call(4,{attendance_id:id(102)})).code,403);assert.equal((await call(1,{attendance_id:id(102)})).passed,true);
 assert.equal((await call(5)).code,403);assert.equal((await call(6)).code,403);assert.equal((await call(2,{attendance_id:'invalid'})).code,400);
 assert.equal((await call(null,{},'/APP/ATTENDANCE/EMPLOYEE/IMAGE/')).code,401);
 assert.equal((await call(null,{},'/app/attendance/employee/face-attendance')).passed,true,'Punch routes are untouched');
}));
test('photo capabilities are specific to one record, punch type and unchanged evidence; arbitrary/session JWTs cannot act as photo links',()=>fixture(async({call,access,db,tokens,reads})=>{
 const token=access.issueImageAccess(id(101),'IN','private-in');assert.equal((await call(null,{image_access:token})).passed,true);
 for(const query of [{attendance_id:id(102),image_access:token},{punch_type:'OUT',image_access:token},{image_access:tokens.get(1)},{image_access:'invalid'}]){const before=reads();assert.equal((await call(null,query)).code,403);assert.equal(reads(),before,'Invalid capability must be rejected before any database lookup');}
 const expired=jwt.sign({attendance_id:id(101),punch_type:'IN'},crypto.createHmac('sha256',process.env.JWT_SECRET).update('attendance-image-capability-v1').digest(),{audience:'attendance-image',issuer:'matrixtrack',expiresIn:-1});assert.equal((await call(null,{image_access:expired})).code,403);
 await db.query("UPDATE attendance SET punch_in_image='changed' WHERE attendance_id=$1",[id(101)]);assert.equal((await call(null,{image_access:token})).code,403);
 assert.throws(()=>jwt.verify(token,process.env.JWT_SECRET),'Photo token cannot be used as a login token');
}));
test('session-check outages fail closed and signed report tokens include mid-shift images',()=>fixture(async({call,access,setUnavailable})=>{
 setUnavailable(true);assert.equal((await call(2)).code,503);
 const records=[{attendance_id:id(101),employee_kind:'regular',punch_in_image:'private-in',mid_shift_punch_in_image:'private-mid'},{attendance_id:'professional:uuid',employee_kind:'professional',punch_in_image:'professional-photo'}];
 await access.addAttendanceImageTokens(records);assert.ok(records[0].punch_in_image_token);assert.ok(records[0].mid_shift_punch_in_image_token);assert.equal(records[1].punch_in_image_token,undefined);
 assert.equal((await call(null,{punch_type:'MID_IN',image_access:records[0].mid_shift_punch_in_image_token})).passed,true);
}));

test('image capability and login tokens are redacted from HTTP trace URLs',()=>{
 const safe=require('../utils/safeRequestUrl');assert.equal(safe('/image?attendance_id=12&image_access=secret&token=login'),'/image?attendance_id=12&image_access=[redacted]&token=[redacted]');
});

test('the photo guard runs before every existing API mount that can serve legacy attendance images',()=>{
 const app=fs.readFileSync('app.js','utf8'),guard=app.indexOf("require('./middleware/attendanceImageGuard')");assert.ok(guard>0);
 for(const mount of ['app.use("/api", allRoutes)','app.use("/api/app", appRoutes)','app.use("/api/app/attendance/employee", selfAttendanceRoutes)']){assert.ok(app.indexOf(mount)>guard,`Photo guard must protect ${mount}`);}
});
