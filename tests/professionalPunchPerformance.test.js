// Offline regression checks; no live database or AWS calls.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
(async()=>{
  let schemaConnections=0,expiryCalls=0,released=0;
  const client={query:async()=>({rows:[]}),release(){released++;}};
  const pool={connect:async()=>{schemaConnections++;return client;},query:async sql=>{assert.equal(sql,'SELECT professional_expire_pending_leaves()');expiryCalls++;}};
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/professionalLeaveSchema.js'),'utf8'),{module:mod,__dirname:path.join(__dirname,'../utils'),require:name=>name==='../config/db'?pool:require(name)});
  await Promise.all(Array.from({length:20},()=>mod.exports.ensureProfessionalLeaveSchema({expirePending:false})));
  assert.equal(schemaConnections,1,'Concurrent punch requests share schema initialization');assert.equal(released,1);assert.equal(expiryCalls,0,'Punch requests avoid global leave-expiry scans');
  await mod.exports.ensureProfessionalLeaveSchema();assert.equal(expiryCalls,1,'Lists still expire overdue requests by default');
  const source=fs.readFileSync(path.join(__dirname,'../controllers/professionalAttendanceController.js'),'utf8');
  const start=source.indexOf('let attendanceColumnsPromise');const end=source.indexOf('const parseNumericCoordinate',start);
  let calls=0,rejectNext=true;
  const sandbox={module:{exports:{}}};
  vm.runInNewContext(source.slice(start,end)+';module.exports=ensureProfessionalAttendanceColumns;',sandbox);
  const db={query:async()=>{calls++;if(rejectNext){rejectNext=false;throw Error('temporary DDL failure');}}};
  const outcomes=await Promise.allSettled(Array.from({length:20},()=>sandbox.module.exports(db)));
  assert.ok(outcomes.every(item=>item.status==='rejected'));assert.equal(calls,1,'Failed concurrent initialization runs only once');
  await Promise.all(Array.from({length:20},()=>sandbox.module.exports(db)));assert.equal(calls,2,'Initialization retries once after failure');
  await sandbox.module.exports(db);assert.equal(calls,2,'Warm requests do not repeat DDL');
  const blockModule={exports:{}};
  const id='00000000-0000-4000-8000-000000000001';
  let blockSchemaConnections=0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/professionalAttendanceBlock.js'),'utf8'),{
    module:blockModule,__dirname:path.join(__dirname,'../utils'),
    require:name=>name==='../config/db' ? {connect:async()=>{blockSchemaConnections++;throw Error('Startup schema is already ready');}} :
      name==='./professionalAttendanceIdentity' ? {attendanceSourceIds:id=>[id]} : require(name),
  });
  blockModule.exports.markAttendanceBlockSchemaReady();
  await Promise.all(Array.from({length:20},()=>blockModule.exports.ensureAttendanceBlockSchema()));
  assert.equal(blockSchemaConnections,0,'Successful startup migration avoids request-time schema connections/DDL');
  let contextCalls=0, blockCommitted=false;
  const contextClient={query:async(sql)=>{
    contextCalls++;
    if(/FOR UPDATE/.test(sql)) {
      // Model waiting for an admin's profile lock: their block commits before
      // this request owns the lock. The next statement must read that block.
      assert.equal(/professional_attendance_blocks/.test(sql),false,'Do not read block state from the pre-lock snapshot');
      await Promise.resolve();blockCommitted=true;
      return {rows:[{id,selfie_url:'profile-photo',is_active:true}]};
    }
    return {rows:[{is_late:false,attendance_block:blockCommitted ? {reason:'Blocked during lock wait',updated_at:'2026-10-21'} : null}]};
  }};
  const context=await blockModule.exports.loadPunchInContext(contextClient,id);
  assert.equal(contextCalls,2,'Block check shares the existing profile/cutoff round-trip budget');
  assert.equal(context.block.is_attendance_blocked,true,'Read committed block state after acquiring the profile lock');
  assert.equal(context.profile.selfie_url,'profile-photo','Reuse the locked profile rather than selecting it twice');
  console.log('PASS: concurrent schema initialization, retry, warm-path DDL avoidance, punch expiry bypass and default leave expiry.');
  console.log('PASS: no extra block-related punch-in round trips, startup schema reuse, profile reuse and block committed during profile-lock wait.');
})().catch(error=>{console.error(error);process.exitCode=1;});
