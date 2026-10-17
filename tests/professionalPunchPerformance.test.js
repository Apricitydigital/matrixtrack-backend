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
  console.log('PASS: concurrent schema initialization, retry, warm-path DDL avoidance, punch expiry bypass and default leave expiry.');
})().catch(error=>{console.error(error);process.exitCode=1;});
