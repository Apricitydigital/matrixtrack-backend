const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const {migrationConnection}=require('../utils/migrationConnection');
const {createStartupCron}=require('../utils/startupCron');

test('cron jobs register only after startup succeeds, once',()=>{
 const scheduled=[];
 const cron=createStartupCron({schedule:(...args)=>scheduled.push(args)});
 const job=()=>{};
 cron.schedule('* * * * *',job,{timezone:'Asia/Kolkata'});
 assert.equal(scheduled.length,0,'No minute callback can run during migrations');
 cron.start();cron.start();assert.equal(scheduled.length,1);
 assert.equal(scheduled[0][1],job);
 cron.schedule('0 * * * *',job);assert.equal(scheduled.length,2);
});

function fakePool(failAt) {
 const queries=[],released=[];
 const previous={statement_timeout:'30s',lock_timeout:'0',idle_timeout:'0',application_name:'api'};
 const raw={query:async config=>{
  queries.push(config);
  if(failAt?.(config,queries.length))throw failAt.error;
  return {rows:[previous]};
 },release:error=>released.push(error)};
 return {pool:{connect:async()=>raw},queries,released,previous};
}
test('migration read timeout exceeds server timeout and API session settings are restored',async()=>{
 const f=fakePool(),client=await migrationConnection(f.pool,{});
 await client.query('SELECT $1',[7]);await client.release();
 assert.ok(f.queries.every(query=>query.query_timeout===130000));
 assert.deepEqual(f.queries[1].values,['120000ms','5000ms']);
 assert.deepEqual(f.queries[2].values,[7]);
 assert.deepEqual(f.queries.at(-1).values,['30s','0','0','api']);
 assert.deepEqual(f.released,[undefined]);
});
test('failed or timed-out migration connections are destroyed, never reused',async()=>{
 const failure=Object.assign(Error('Query read timeout'),{code:'TEST_TIMEOUT'});
 const failAt=config=>config.text==='ALTER TABLE attendance';failAt.error=failure;
 const f=fakePool(failAt),client=await migrationConnection(f.pool,{});
 client.setStep('attendance schema');
 await assert.rejects(client.query('ALTER TABLE attendance'),error=>error===failure);
 await client.release();
 assert.equal(f.released[0],failure);assert.equal(failure.migrationStep,'attendance schema');
 assert.equal(f.queries.length,3,'No reset query is queued on the timed-out connection');
});
test('failure while configuring the session also destroys the connection',async()=>{
 const failAt=(_config,n)=>n===2;failAt.error=Error('Connection lost');
 const f=fakePool(failAt);
 await assert.rejects(migrationConnection(f.pool,{}),error=>error===failAt.error);
 assert.equal(f.released[0],failAt.error);
});

function loadRunner({failure,rollbackFails=false}={}) {
 const queries=[],released=[],ready=[],leaveOptions=[];
 const client={setStep(){},query:async sql=>{
  queries.push(sql);
  if(sql==='ROLLBACK' && rollbackFails)throw Error('rollback transport failure');
  if(failure && sql.includes('ALTER TABLE attendance'))throw failure;
  return {rows:[]};
 },release:error=>released.push(error)};
 const mocks={
  '../config/db':{},fs:{existsSync:()=>true,readFileSync:()=> 'SELECT 1'},path,
  '../utils/migrationConnection':{migrationConnection:async()=>client},
  '../utils/professionalLeaveSchema':{ensureProfessionalLeaveSchema:async options=>leaveOptions.push(options)},
  '../utils/professionalPushService':{ensureProfessionalPushSchema:async()=>{}},
  '../utils/professionalAttendanceBlock':{markAttendanceBlockSchemaReady:()=>ready.push('blocks')},
  '../utils/professionalPunchCutoff':{markPunchCutoffSchemaReady:()=>ready.push('cutoff')},
 };
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../db/migrations.js'),'utf8'),{
  require:name=>{if(!Object.hasOwn(mocks,name))throw Error(name);return mocks[name];},
  module,__dirname:path.join(__dirname,'../db'),console:{log(){},error(){},warn(){}},
 });
 return {...module.exports,queries,released,ready,leaveOptions};
}
test('startup preserves the original failure even when rollback fails',async()=>{
 const original=Object.assign(Error('canceling statement due to lock timeout'),{code:'55P03'});
 const r=loadRunner({failure:original,rollbackFails:true});
 await assert.rejects(r.runMigrations(),error=>error===original);
 assert.equal(r.released[0],original);assert.deepEqual(r.ready,[]);
});
test('read timeout skips queued rollback and fails startup with its original error',async()=>{
 const original=Error('Query read timeout'),r=loadRunner({failure:original});
 await assert.rejects(r.runMigrations(),error=>error===original);
 assert.ok(!r.queries.includes('ROLLBACK'));assert.equal(r.released[0],original);
});
test('successful startup warms cutoff/block schema and avoids leave-expiry scan',async()=>{
 const r=loadRunner();await r.runMigrations();
 assert.equal(r.queries.at(-1),'COMMIT');assert.deepEqual(r.ready,['blocks','cutoff']);
 assert.equal(r.leaveOptions[0].expirePending,false);assert.deepEqual(r.released,[undefined]);
});
