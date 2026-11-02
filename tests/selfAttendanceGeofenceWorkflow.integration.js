const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const person='b0000000-0000-4000-8000-000000000001';
function load(relative,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',relative),'utf8'),{module,process:{env:{}},console,require:name=>{assert.ok(name in deps,name);return deps[name];}});return module.exports;}
test('NULL-Sector geofence request, scoped approval, radius, rejection and deletion preserve physical Ward and attendance isolation',async()=>{
 const db=new PGlite();let pushCalls=0,smsCalls=0;try{
 await db.exec(`CREATE TABLE cities(city_id INT PRIMARY KEY);INSERT INTO cities VALUES(1),(2);
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(10,1),(20,2);
 CREATE TABLE sectors(sector_id INT PRIMARY KEY,zone_id INT);CREATE TABLE wards(ward_id INT PRIMARY KEY,zone_id INT,sector_id INT);INSERT INTO wards VALUES(1001,10,NULL);
 CREATE TABLE users(user_id INT PRIMARY KEY);INSERT INTO users VALUES(1);
 CREATE TABLE self_attendance_employees(id UUID PRIMARY KEY,full_name TEXT,mobile TEXT,email TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,is_active BOOLEAN);
 INSERT INTO self_attendance_employees VALUES('${person}','Test Employee','9999999999','test@example.test',1,10,NULL,1001,TRUE);
 CREATE TABLE self_attendance_notifications(id UUID DEFAULT gen_random_uuid(),self_attendance_id UUID,type TEXT,title TEXT,message TEXT,metadata JSONB);`);
 const client={release(){},query:async(sql,params=[])=>{
  if(/CREATE EXTENSION IF NOT EXISTS pgcrypto/.test(sql))return {rows:[],rowCount:0};
  assert.ok(!/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:attendance|self_attendance_records)\b/i.test(sql),'Geofence workflow must not change punches');
  const result=await db.query(sql,params);return {...result,rowCount:result.affectedRows??result.rows.length};
 }};
 const pool={query:client.query,connect:async()=>client};
 const schema=load('utils/selfAttendanceGeofenceSchema.js',{'../config/db':pool});
 const visibility=require('../utils/selfAttendanceAccess');
 const api=load('controllers/selfAttendanceGeofenceController.js',{
  '../config/db':pool,'../utils/logger':{info(){},warn(){},error(){}},'../utils/selfAttendanceAccess':visibility,
  '../utils/geofencing':load('utils/geofencing.js',{'../config/db':pool}),
  '../utils/selfAttendanceGeofenceSchema':schema,'../utils/selfAttendanceLeaveSchema':{ensureSelfAttendanceLeaveSchema:async()=>{}},
  '../utils/selfAttendanceFeatureSettings':{getSelfAttendanceFeatureSettings:async()=>({geofence_enforcement_enabled:true})},
  '../utils/selfAttendancePushService':{sendPushToSelfAttendances:async()=>{pushCalls++;}},'../utils/smsNotifier':{sendSms:async()=>{smsCalls++;}},
 });
 const run=async(method,request)=>{const res={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await api[method](request,res);return res;};
 const submit=(latitude=22.7,longitude=75.8)=>run('submitSelfAttendanceGeofenceRequest',{self_attendance:{self_attendance_id:person},body:{latitude,longitude,radius_meters:150}});
 const admin=(id,body={},city=1)=>({user:{user_id:1,role:'admin'},cityScope:{all:false,ids:[city]},params:{id},body,query:{}});
 for(const [lat,lng]of [[null,null],[91,75.8],[22.7,181],['','']])assert.equal((await submit(lat,lng)).code,400);
 const created=await submit();assert.equal(created.code,201);const id=created.body.data.id;
 assert.equal(created.body.data.ward_id,null);assert.equal(created.body.data.kothi_id,1001);
 assert.equal((await submit()).code,409,'Nearby duplicate pending request is rejected');
 assert.equal((await run('reviewSelfAttendanceGeofenceRequest',admin(id,{status:'approved'},2))).code,404);
 assert.equal((await run('reviewSelfAttendanceGeofenceRequest',admin(id,{status:'approved',radius_meters:150}))).code,200);
 assert.equal((await run('reviewSelfAttendanceGeofenceRequest',admin(id,{status:'approved'}))).code,400,'Review cannot be repeated');
 const validate=(lat,lng)=>api.validateSelfAttendanceGeofenceAccess({selfAttendanceId:person,latitude:lat,longitude:lng,clientRef:pool});
 assert.equal((await validate(22.7,75.8)).allowed,true);assert.equal((await validate(22.7015,75.8)).allowed,false);
 assert.equal((await run('updateSelfAttendanceGeofenceRadius',admin(id,{radius_meters:250}))).code,200);
 assert.equal((await validate(22.7015,75.8)).allowed,true);assert.equal((await submit()).code,409,'Already approved nearby point is protected');
 const other=await submit(23,76);assert.equal(other.code,201);
 assert.equal((await run('reviewSelfAttendanceGeofenceRequest',admin(other.body.data.id,{status:'rejected'}))).code,400);
 assert.equal((await run('reviewSelfAttendanceGeofenceRequest',admin(other.body.data.id,{status:'rejected',reason:'Wrong site'}))).code,200);
 assert.ok(pushCalls>=2&&smsCalls>=2,'Notifications reach only test provider stubs');
 assert.equal((await run('deleteSelfAttendanceGeofenceRequest',admin(id,{},2))).code,404);
 assert.equal((await run('deleteSelfAttendanceGeofenceRequest',admin(id))).code,200);
 assert.equal((await validate(22.7,75.8)).allowed,false,'Deleting approval removes punch eligibility');
 assert.equal((await db.query('SELECT kothi_id FROM self_attendance_employees WHERE id=$1',[person])).rows[0].kothi_id,1001);
 }finally{await db.close();}
});
