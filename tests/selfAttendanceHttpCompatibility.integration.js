'use strict';
// Real Express request parsing, route mounts, cookies/JWT auth and response JSON.
// Business/SQL write guards have their own PostgreSQL tests. No sockets, live DB,
// SMS, push providers, S3 or face-recognition calls are made by this fixture.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {PassThrough}=require('node:stream');
const express=require('express'),jwt=require('jsonwebtoken');
const compatibility=require('../middleware/selfAttendanceCompatibility');
const id='a0000000-0000-4000-8000-000000000001',secret='offline-http-naming-fixture';
function load(relative,deps){const file=path.join(__dirname,'..',relative),module={exports:{}};
 vm.compileFunction(fs.readFileSync(file,'utf8'),['require','module','__dirname','process'],{filename:file})(name=>{
  assert.ok(Object.hasOwn(deps,name),'Unexpected dependency '+name);return deps[name];
 },module,path.dirname(file),{env:{JWT_SECRET:secret}});return module.exports;}
function fixture(){
 const seen=[];
 const auth=load('middleware/selfAttendanceAuth.js',{jsonwebtoken:jwt,'../utils/employeeAliases':{resolveEmployeeAlias:async(kind,value)=>{assert.equal(kind,'self_attendance');return value;}},
  '../config/db':{query:async(sql,params)=>{assert.match(sql,/self_attendance_employees/);assert.equal(params[0],id);return {rows:[{is_active:true,city_id:1,zone_id:2,ward_id:100,kothi_id:10}]};}}});
 const handler=name=>(req,res)=>{seen.push({name,identity:req.self_attendance?.self_attendance_id,body:req.body,query:req.query});
  if(name==='punchIn')return res.status(403).json({success:false,code:'SELF_ATTENDANCE_GEOFENCE_OUTSIDE',self_attendance_id:id});
  if(name==='punchOut')return res.status(403).json({success:false,code:'ATTENDANCE_BLOCKED',is_attendance_blocked:true});
  return res.json({success:true,data:{id,self_attendance_id:id,employee_kind:'self_attendance',attendance_mode:'self_attendance',self_attendance_enabled:true,selfie_url:'professional/keep-original.jpg'}});
 };
 const obj=names=>Object.fromEntries(names.map(name=>[name,handler(name)]));
 const selfRoutes=load('routes/selfAttendanceRoutes.js',{
  express,'../middleware/selfAttendanceAuth':auth,'../utils/selfAttendanceRecordsIdentity':{resolveAttendanceIdentity:(req,res,next)=>next()},
  '../controllers/selfAttendanceAuthController':obj(['login']),'../controllers/selfAttendanceOtpController':obj(['sendOtp','verifyOtp']),
  '../controllers/selfAttendanceRecordsController':obj(['punchIn','punchOut','getMonthlyAttendance','getTodayStatus','getProfile']),
  '../controllers/selfAttendanceLeaveController':obj(['getMyNotifications','markNotificationRead']),
  '../controllers/selfAttendanceLeaveWorkflowController':obj(['requestLeave','getMyLeaveRequests','getBalance','getTeamRequests','review']),
  '../utils/selfAttendancePushService':{sendPushToSelfAttendances:async()=>{throw Error('Unexpected push');}},
  '../controllers/selfAttendancePushController':obj(['registerPushToken','unregisterPushToken']),
  '../controllers/selfAttendanceGeofenceController':obj(['getMyGeofenceStatus','submitSelfAttendanceGeofenceRequest']),
  '../controllers/selfAttendanceReminderSettingsController':obj(['getReminderSettings','saveReminderSettings']),
  '../utils/selfAttendancePunchInReminder':{runSelfAttendancePunchInReminder:async()=>{throw Error('Unexpected reminder');}},
 });
 const route=(url,name,method='get')=>{const r=express.Router();r.use(auth);r[method](url,handler(name));return r;};
 const specific={
  './selfAttendanceRoutes':selfRoutes,
  './supervisorAttendanceRoutes':route('/sites','supervisorSites'),
  './registerAttendanceRoutes':route('/requests','registerRequest','post'),
  './selfAttendanceEmployeeBlockRoutes':route('/:id','changeBlock','patch'),
  './selfAttendancePunchCutoffRoutes':route('/capabilities','cutoffCapabilities'),
  './selfAttendanceReportsRoutes':route('/self-attendance-records','attendanceReport'),
  './combinedAttendanceRoutes':route('/','combinedReport','post'),
  './selfAttendanceWeeklyOffRoutes':{app:route('/sites','weeklyOffSites'),admin:express.Router()},
 };
 const indexFile=path.join(__dirname,'../routes/index.js');
 const imports=[...fs.readFileSync(indexFile,'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]);
 const deps=Object.fromEntries(imports.map(name=>[name,name==='express'?express:specific[name]||express.Router()]));
 const allRoutes=load('routes/index.js',deps);
 const app=express();app.use(express.json());app.use(require('cookie-parser')());app.use(compatibility);app.use('/api',allRoutes);
 app.use((req,res)=>res.status(404).json({error:'Route not found'}));
 function request(url,{method='GET',body,claims={professional_id:id},headers={}}={}){
  return new Promise((resolve,reject)=>{
   const req=new http.IncomingMessage(new PassThrough());req.method=method;req.url=url;
   const encoded=body===undefined?null:Buffer.from(JSON.stringify(body));
   req.headers={...(claims?{authorization:'Bearer '+jwt.sign(claims,secret)}:{}),...(encoded?{'content-type':'application/json','content-length':String(encoded.length)}:{}),...headers};
   const res=new http.ServerResponse(req),chunks=[];res.write=chunk=>{chunks.push(Buffer.from(chunk));return true;};
   res.end=chunk=>{if(chunk)chunks.push(Buffer.from(chunk));try{resolve({code:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}return res;};
   app.handle(req,res,reject);if(encoded)req.push(encoded);req.push(null);
  });
 }
 return {request,seen};
}
test('installed mobile punch errors keep geofence codes and block behavior; canonical APIs return canonical codes',async()=>{
 const f=fixture();
 const legacy=await f.request('/api/professional/attendance/punch-in',{method:'POST',body:{latitude:22,longitude:75}});
 assert.equal(legacy.code,403);assert.equal(legacy.body.code,'PROFESSIONAL_GEOFENCE_OUTSIDE');assert.equal(legacy.body.professional_id,id);
 const canonical=await f.request('/api/self-attendance/attendance/punch-in',{method:'POST',claims:{self_attendance_id:id},body:{latitude:22,longitude:75}});
 assert.equal(canonical.body.code,'SELF_ATTENDANCE_GEOFENCE_OUTSIDE');assert.equal(canonical.body.self_attendance_id,id);
 const blocked=await f.request('/api/professional/attendance/punch-out',{method:'POST',body:{}});
 assert.equal(blocked.code,403);assert.equal(blocked.body.code,'ATTENDANCE_BLOCKED');assert.equal(blocked.body.is_attendance_blocked,true);
 assert.ok(f.seen.every(entry=>entry.identity===id));
});
test('real route mounts keep supervisor/register/weekly-off/cutoff endpoints ahead of the generic employee router',async()=>{
 const f=fixture();
 for(const [suffix,name,method] of [['supervisor-attendance/sites','supervisorSites','GET'],['register-attendance/requests','registerRequest','POST'],['weekly-off/sites','weeklyOffSites','GET'],['punch-cutoff/capabilities','cutoffCapabilities','GET']]){
  for(const prefix of ['professional','self-attendance']){
   const result=await f.request('/api/'+prefix+'/'+suffix,{method,...(method==='POST'?{body:{emp_id:123}}:{})});
   assert.equal(result.code,200);assert.equal(f.seen.at(-1).name,name);
   assert.equal(result.body.data[prefix==='professional'?'professional_id':'self_attendance_id'],id);
  }
 }
});
test('admin block/report aliases and combined-report filters survive Express query and JSON parsing',async()=>{
 const f=fixture();
 assert.equal((await f.request('/api/admin/professional-employee-blocks/'+id,{method:'PATCH',body:{is_blocked:true,expected_blocked:false,reason:'Audit fixture'}})).code,200);
 assert.equal(f.seen.at(-1).name,'changeBlock');assert.equal(f.seen.at(-1).body.is_blocked,true);
 const report=await f.request('/api/admin/professional-attendance?professional_id='+id);
 assert.equal(report.code,200);assert.equal(f.seen.at(-1).name,'attendanceReport');assert.equal(f.seen.at(-1).query.self_attendance_id,id);
 const combined=await f.request('/api/attendance/combined',{method:'POST',body:{employeeType:'professional'}});
 assert.equal(combined.code,200);assert.equal(f.seen.at(-1).body.employeeType,'self_attendance');assert.equal(combined.body.data.employee_kind,'professional');
 const canonical=await f.request('/api/attendance/combined',{method:'POST',body:{employeeType:'all'},headers:{'x-attendance-naming':'self-attendance'}});
 assert.equal(canonical.body.data.employee_kind,'self_attendance');assert.equal(canonical.body.data.self_attendance_enabled,true);
 assert.equal(canonical.body.data.selfie_url,'professional/keep-original.jpg');
});
test('legacy monthly/profile routes retain field names; missing or wrong token types cannot reach a handler',async()=>{
 const f=fixture();
 for(const endpoint of ['profile','attendance/monthly','attendance/status']){
  const result=await f.request('/api/professional/'+endpoint);assert.equal(result.code,200);assert.equal(result.body.data.professional_id,id);
 }
 const count=f.seen.length;
 assert.equal((await f.request('/api/professional/profile',{claims:null})).code,401);
 assert.equal((await f.request('/api/professional/profile',{claims:{user_id:1}})).code,403);
 assert.equal(f.seen.length,count);
});
