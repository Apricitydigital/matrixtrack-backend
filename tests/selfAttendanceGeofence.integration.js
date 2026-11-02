'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const {contractValue}=require('../utils/selfAttendanceNaming');
const person='b0000000-0000-4000-8000-000000000001';
function load(relative,deps){const file=path.join(__dirname,'..',relative),module={exports:{}};
 vm.compileFunction(fs.readFileSync(file,'utf8'),['require','module','process'],{filename:file})(name=>{assert.ok(Object.hasOwn(deps,name),'Unexpected dependency '+name);return deps[name];},module,{env:{}});return module.exports;}
async function fixture(run){const db=new PGlite();let enabled=true;const forbidden=()=>{throw Error('Unexpected write/provider call');};
 try{
  await db.exec(`CREATE TABLE self_attendance_geofences(id UUID DEFAULT gen_random_uuid(),self_attendance_id UUID,is_active BOOLEAN DEFAULT TRUE,latitude NUMERIC,longitude NUMERIC,radius_meters INT,approved_at TIMESTAMPTZ DEFAULT NOW(),created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE self_attendance_geofence_requests(id UUID DEFAULT gen_random_uuid(),self_attendance_id UUID,status TEXT,latitude NUMERIC,longitude NUMERIC,created_at TIMESTAMPTZ DEFAULT NOW());`);
  const pool={query:db.query.bind(db)};
  const geofencing=load('utils/geofencing.js',{'../config/db':pool});
  const api=load('controllers/selfAttendanceGeofenceController.js',{
   '../config/db':pool,'../utils/logger':{info(){},warn(){},error:forbidden},'../utils/selfAttendanceAccess':{buildVisibilityScope:forbidden},
   '../utils/geofencing':geofencing,'../utils/selfAttendanceGeofenceSchema':{ensureSelfAttendanceGeofenceSchema:async()=>{}},
   '../utils/selfAttendanceLeaveSchema':{ensureSelfAttendanceLeaveSchema:async()=>{}},
   '../utils/selfAttendanceFeatureSettings':{getSelfAttendanceFeatureSettings:async()=>({geofence_enforcement_enabled:enabled}),setSelfAttendanceGeofenceEnforcement:forbidden},
   '../utils/selfAttendancePushService':{sendPushToSelfAttendances:forbidden},'../utils/smsNotifier':{sendSms:forbidden},
  });
  const validate=(latitude,longitude)=>api.validateSelfAttendanceGeofenceAccess({selfAttendanceId:person,latitude,longitude,clientRef:pool});
  const fence=(latitude,longitude,radius=150)=>db.query('INSERT INTO self_attendance_geofences(self_attendance_id,latitude,longitude,radius_meters) VALUES($1,$2,$3,$4)',[person,latitude,longitude,radius]);
  await run({db,validate,fence,setEnabled:value=>{enabled=value;}});
 }finally{await db.close();}}
test('geofence enforcement switch and pending location requests preserve their intended behavior',()=>fixture(async({db,validate,setEnabled})=>{
 setEnabled(false);assert.equal((await validate(null,null)).allowed,true);setEnabled(true);
 await db.query("INSERT INTO self_attendance_geofence_requests(self_attendance_id,status,latitude,longitude) VALUES($1,'pending',22.7,75.8)",[person]);
 const result=await validate(22.7,75.8);assert.equal(result.allowed,false);assert.equal(result.code,'SELF_ATTENDANCE_GEOFENCE_MISSING');assert.equal(result.has_pending_request,true);
 assert.equal(contractValue(result,'legacy').code,'PROFESSIONAL_GEOFENCE_MISSING');
}));
test('approved locations allow valid GPS and reject points outside the actual radius',()=>fixture(async({fence,validate})=>{
 await fence(22.7,75.8);assert.equal((await validate('22.7','75.8')).allowed,true);
 const outside=await validate(23,76);assert.equal(outside.allowed,false);assert.equal(outside.code,'SELF_ATTENDANCE_GEOFENCE_OUTSIDE');assert.ok(outside.distance_meters>150);
 await fence(23,76);assert.equal((await validate(23,76)).allowed,true,'Any assigned approved location may be used');
}));
test('blank, absent, nonnumeric and out-of-range GPS cannot become a valid zero-coordinate punch',()=>fixture(async({fence,validate})=>{
 await fence(0,0);
 for(const [latitude,longitude] of [[null,null],[undefined,undefined],['',''],[' ',' '],[false,false],[[],[]],[{},{}],['invalid','0'],[360,0],[0,360],[Infinity,0]]){
  const result=await validate(latitude,longitude);assert.equal(result.allowed,false);assert.equal(result.code,'SELF_ATTENDANCE_GEOFENCE_LOCATION_REQUIRED');
 }
 assert.equal((await validate(0,0)).allowed,true,'Explicit numeric zero coordinates remain valid');
}));
