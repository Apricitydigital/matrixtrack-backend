// Called by the isolated workforce fixture. Uses real JWT verification, merge,
// profile, attendance guards and SQL writes; no live database/AWS/device access.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const jwt=require('jsonwebtoken');
module.exports=async({db,pool,call})=>{
 const secret='offline-merge-session-fixture-only';
 const load=(relative,deps={})=>{
  const file=path.join(__dirname,relative),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,__dirname:path.dirname(file),console,
   process:{env:{JWT_SECRET:secret,PROFESSIONAL_LIVENESS_ENABLED:'false'}},Buffer,
   require:name=>{
    if(Object.hasOwn(deps,name))return deps[name];
    if(name==='../config/db')return pool;
    if(['fs','path','jsonwebtoken'].includes(name))return require(name);
    throw Error(`Unexpected test dependency: ${name}`);
   }});
  return module.exports;
 };
 await db.exec(`ALTER TABLE professional_employees ADD COLUMN face_locked BOOLEAN DEFAULT TRUE,ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
 ALTER TABLE zones ADD COLUMN zone_name TEXT;
 CREATE TABLE sectors(sector_id INT PRIMARY KEY,sector_name TEXT);
 ALTER TABLE professional_leave_requests ADD COLUMN leave_type TEXT;
 ALTER TABLE professional_attendance ADD COLUMN IF NOT EXISTS ward_id INT,ADD COLUMN IF NOT EXISTS zone_id INT;
 CREATE TABLE permissions(id SERIAL PRIMARY KEY,module TEXT,action TEXT);
 CREATE TABLE professional_holidays(id SERIAL PRIMARY KEY,holiday_date DATE,holiday_name TEXT,description TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE FUNCTION professional_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS 'SELECT FALSE';`);
 for(const migration of ['20261014_professional_punch_cutoff.sql','20261021_professional_attendance_blocks.sql','20261022_professional_attendance_site.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',migration),'utf8'));
 const identities=require('../utils/professionalAttendanceIdentity');
 const blocks=load('../utils/professionalAttendanceBlock.js',{'./professionalAttendanceIdentity':identities});
 blocks.markAttendanceBlockSchemaReady();
 const cutoff=load('../utils/professionalPunchCutoff.js');
 let faceAllowed=true,geoAllowed=true,faceCalls=0,expectedFace='same-enrolled-face';
 const controller=load('../controllers/professionalAttendanceController.js',{
  '../utils/professionalAttendanceSite':require('../utils/professionalAttendanceSite'),
  '../utils/professionalAttendanceIdentity':identities,
  '../utils/professionalAttendanceBlock':blocks,
  '../utils/professionalPunchCutoff':{...cutoff,ensurePunchCutoffSchema:async()=>{},getPunchSettings:async()=>(await pool.query('SELECT enabled FROM professional_punch_settings WHERE id=1')).rows[0]},
  '../utils/logger':{info(){},warn(){},error:(...args)=>console.error(...args)},
  '../utils/faceService':{verifyFaceMatch:async key=>{faceCalls++;assert.equal(key,expectedFace);return {isMatch:faceAllowed,confidence:faceAllowed?99:10};}},
  '../config/awsConfig':{},'../utils/s3SelfPunch':{getSignedS3Url:async value=>value,uploadToS3:async()=>null},
  '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async()=>{}},
  '../utils/cityTrafficCost':{trackSuccessfulAttendanceEvent(){},sendTrackedRekognition:async()=>{throw Error('Unexpected AWS request');}},
  './professionalGeofenceController':{validateProfessionalGeofenceAccess:async()=>({allowed:geoAllowed,code:'OUTSIDE_GEOFENCE',message:'Outside site'})},
  './consentController':{logUserConsent:async()=>{}},
 });
 let aliases=load('../utils/employeeAliases.js');
 let authenticate=load('../middleware/professionalAuth.js',{'../utils/employeeAliases':aliases});
 const request=async(token,action)=>{
  const req={cookies:{},header:name=>name.toLowerCase()==='authorization'?`Bearer ${token}`:null,
   body:{selfie_base64:'eA==',latitude:22,longitude:75},headers:{'user-agent':'Offline Mobile Fixture'},query:{}};
  const res={code:200,status(value){this.code=value;return this;},json(value){this.body=value;return this;}};
  let authorized=false;await authenticate(req,res,()=>{authorized=true;});
  if(authorized){
   let proceed=false;await identities.resolveAttendanceIdentity(req,res,()=>{proceed=true;});
   if(proceed)await controller[action](req,res);
  }
  return res;
 };
 for(const [index,scenario] of ['Merge before any punch','Punch-in before merge; punch-out after merge','Open overlapping punches consolidated before punch-out'].entries()) {
  const ids=[1,2,3].map(n=>`b0000000-0000-4000-8000-${String(index*10+n).padStart(12,'0')}`);
  for(const [n,id] of ids.entries())await db.query(`INSERT INTO professional_employees(id,full_name,emp_code,mobile,city_id,zone_id,ward_id,kothi_id,is_active,selfie_url,email,password_hash) VALUES($1,'Ashu','ASHU-SESSION','9876543210',1,1,10,10,TRUE,$2,'ashu-session@example.test','same-hash')`,[id,n===0?'same-enrolled-face':`retired-face-${index}-${n}`]);
  // These tokens are issued before any merge and are never replaced/refreshed.
  const tokens=ids.map(id=>jwt.sign({professional_id:id,city_id:999,zone_id:999,ward_id:999},secret,{expiresIn:'1h'}));
  let originalPunch;
  if(index>0){
   expectedFace=`retired-face-${index}-1`;
   const before=await request(tokens[1],'punchIn');assert.equal(before.code,200,JSON.stringify(before.body));
   originalPunch=(await db.query('SELECT id,punch_in FROM professional_attendance WHERE professional_id=$1',[ids[1]])).rows[0];
   if(index===2)await db.query(`INSERT INTO professional_attendance(professional_id,date,punch_in,ward_id,zone_id,city_id,punch_in_latitude,punch_in_longitude,punch_approval_status)
    SELECT $1,date,punch_in,ward_id,zone_id,city_id,punch_in_latitude,punch_in_longitude,punch_approval_status FROM professional_attendance WHERE professional_id=$2`,[ids[0],ids[1]]);
  }
  const params={kind:'professional',id:ids[0]},body={sourceIds:ids.slice(1)};
  const preview=await call('post','/:kind/:id/merge-preview',{params,body});assert.equal(preview.code,200,JSON.stringify(preview.data));
  const merged=await call('post','/:kind/:id/merge',{params,body:{...body,reason:scenario,confirmation:ids[0],fingerprint:preview.data.fingerprint}});
  assert.equal(merged.code,200,JSON.stringify(merged.data));
  expectedFace='same-enrolled-face';
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees WHERE id=ANY($1::uuid[])',[ids])).rows[0].n,1);
  // A process restart must not lose the persisted mapping for a deleted ID.
  aliases=load('../utils/employeeAliases.js');
  authenticate=load('../middleware/professionalAuth.js',{'../utils/employeeAliases':aliases});
  for(const token of tokens){
   const profile=await request(token,'getProfile');assert.equal(profile.code,200,JSON.stringify(profile.body));
   assert.equal(profile.body.data.id,ids[0]);assert.equal(profile.body.success,true);assert.equal(profile.body.data.selfie_url,'same-enrolled-face');
   assert.equal(profile.body.token,undefined,'Existing mobile login does not need a replacement token');
  }
  assert.equal(jwt.verify(tokens[1],secret).professional_id,ids[1],'Mobile still carries its original pre-merge token');
  if(index===0){
   const inside=await request(tokens[1],'punchIn');assert.equal(inside.code,200,JSON.stringify(inside.body));assert.equal(inside.body.status,'present');
  }
  const duplicate=await request(tokens[2],'punchIn');assert.equal(duplicate.code,409,'Another old ID cannot create a second daily attendance');
  const status=await request(tokens[1],'getTodayStatus');assert.equal(status.code,200,JSON.stringify(status.body));assert.equal(status.body.data.status,'present');
  const out=await request(tokens[index===0?2:1],'punchOut');assert.equal(out.code,200,JSON.stringify(out.body));assert.equal(out.body.success,true);
  const finished=(await db.query('SELECT id,punch_in,punch_out,ward_id,zone_id,city_id,kothi_id FROM professional_attendance WHERE professional_id=$1',[ids[0]])).rows;
  assert.equal(finished.length,1);assert.ok(finished[0].punch_in);assert.ok(finished[0].punch_out);
  assert.equal(finished[0].city_id,1);assert.equal(finished[0].ward_id,10,'Current profile geography replaces stale JWT geography');
  assert.equal(finished[0].kothi_id,10,'Punch captures its site independently of a later profile transfer');
  if(originalPunch){assert.equal(new Date(finished[0].punch_in).getTime(),new Date(originalPunch.punch_in).getTime());if(index===1)assert.equal(finished[0].id,originalPunch.id);}
  const completed=await request(tokens[2],'getTodayStatus');assert.equal(completed.code,200);assert.equal(completed.body.data.status,'done');
  assert.equal((await request(tokens[2],'punchOut')).code,409,'Repeat punch-out must not overwrite the recorded time');
  console.log(`PASS: pre-merge signed mobile tokens: ${scenario}; profile/status/punch-out work after duplicate deletion and alias-cache restart.`);
 }
 // Merge redirection must preserve authentication and attendance access controls.
 assert.equal((await request('tampered.invalid.token','getProfile')).code,403);
 const inactive='b0000000-0000-4000-8000-000000000001';
 await db.query('UPDATE professional_employees SET is_active=FALSE WHERE id=$1',[inactive]);
 const inactiveToken=jwt.sign({professional_id:'b0000000-0000-4000-8000-000000000002'},secret,{expiresIn:'1h'});
 assert.equal((await request(inactiveToken,'getProfile')).code,403);
 const expired=jwt.sign({professional_id:inactive},secret,{expiresIn:-1});assert.equal((await request(expired,'getProfile')).code,403);
 const active='b0000000-0000-4000-8000-000000000011',oldId='b0000000-0000-4000-8000-000000000012';
 const oldToken=jwt.sign({professional_id:oldId},secret,{expiresIn:'1h'});
 await db.query('DELETE FROM professional_attendance WHERE professional_id=$1',[active]);
 faceAllowed=false;assert.equal((await request(oldToken,'punchIn')).code,403);
 faceAllowed=true;geoAllowed=false;const callsBefore=faceCalls;assert.equal((await request(oldToken,'punchIn')).code,403);assert.equal(faceCalls,callsBefore);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance WHERE professional_id=$1',[active])).rows[0].n,0);
 console.log('PASS: expired/tampered tokens and inactive main profiles stay blocked; face/geofence failures do not save attendance.');
};
