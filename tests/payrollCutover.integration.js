'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture,adapter,protectedRows}=require('./helpers/wardNameFixture');
const {capturePayrollInputs,assertPayrollInputsUnchanged,summarizePayrollInputs}=require('../utils/payrollAttendanceReconciliation');
const {previewWardNames}=require('../utils/wardNameMigration');
const {previewWardNameCapacity,applyWardNameCapacity}=require('../utils/wardNameCapacity');
const {retireSectorMemberships,restoreSectorMemberships}=require('../utils/sectorRetirement');
const {main}=require('../scripts/retire-sector-memberships');
const {fullRowFingerprint}=require('../utils/fullRowFingerprint');

test('2,002 employees retain all 62,032 attendance rows, employee-month inputs and open punches across capacity/names/rollback',async()=>{
 const db=await fixture();try{
  await db.exec(`UPDATE sectors SET sector_name=repeat('P',95) WHERE sector_id=10;
   INSERT INTO employee(emp_id,emp_code,name,ward_id) SELECT 10000+n,'QA-PAY-'||n,'QA Payroll Worker '||n,1008 FROM generate_series(1,2001) n;
   INSERT INTO attendance(attendance_id,emp_id,ward_id,date,punch_in_time,punch_out_time,status)
   SELECT 100000+n*31+d,10000+n,1008,DATE '2026-10-01'+d-1,
    (DATE '2026-10-01'+d-1)+TIME '09:00',CASE WHEN n=1 AND d=31 THEN NULL ELSE (DATE '2026-10-01'+d-1)+TIME '17:00' END,'present'
   FROM generate_series(1,2001) n CROSS JOIN generate_series(1,31) d`);
  const before=await capturePayrollInputs(adapter(db)),summary=summarizePayrollInputs(before);
  assert.equal(summary.regular.employees,2002);assert.equal(summary.regular.records,'62032');assert.equal(summary.regular.openPunches,'2');
  await db.exec('BEGIN');const capacity=await previewWardNameCapacity(adapter(db),await previewWardNames(adapter(db)));await applyWardNameCapacity(adapter(db),capacity);
  const applied=await retireSectorMemberships(adapter(db),()=>{},{combineWardNames:true,requireCompleteSchema:true});await db.exec('COMMIT');
  assert.equal(applied.payrollInputsVerified,true);assertPayrollInputsUnchanged(before,await capturePayrollInputs(adapter(db)));
  await db.exec('BEGIN');const restored=await restoreSectorMemberships(adapter(db),()=>{},{verifyPayrollInputs:true});await db.exec('COMMIT');
  assert.equal(restored.payrollInputsVerified,true);assertPayrollInputsUnchanged(before,await capturePayrollInputs(adapter(db)));
 }finally{await db.close();}
});

test('same-count/same-duration date changes and employee reassignment are rejected by payroll input reconciliation',async()=>{
 const db=await fixture();try{
  const before=await capturePayrollInputs(adapter(db));
  for(const update of ["date=date+1",'emp_id=99',"punch_in_time=punch_in_time+INTERVAL '1 hour'","status='absent'"]){
   await db.exec('BEGIN;UPDATE attendance SET '+update+' WHERE attendance_id=1');
   const after=await capturePayrollInputs(adapter(db));assert.throws(()=>assertPayrollInputsUnchanged(before,after),/Payroll attendance inputs changed/);await db.exec('ROLLBACK');
  }
 }finally{await db.close();}
});

test('one-shot CLI cutover rolls back the legacy table rename when a later phase fails; successful apply is one commit',async()=>{
 const db=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-cutover-'));try{
  const before=await protectedRows(db);await db.exec('ALTER TABLE self_attendance_employees RENAME TO professional_employees;ALTER TABLE self_attendance_records RENAME COLUMN self_attendance_id TO professional_id;ALTER TABLE self_attendance_records RENAME TO professional_attendance');
  const envFile=path.join(dir,'fake.env');fs.writeFileSync(envFile,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  const args=['--env-file='+envFile,'--expected-host=fixture','--expected-database=postgres','--include-self-attendance-rename','--apply','--maintenance-confirmed','--compatible-code-deployed'];
  let commits=0,fail=true;
  class ClientType{async connect(){}async end(){}async query(sql,params){
   if(fail&&sql.includes('ALTER COLUMN ward_id DROP NOT NULL'))throw Error('injected late failure');
   const result=await adapter(db).query(sql,params);if(sql==='COMMIT'){commits++;return {...result,command:'COMMIT'};}return result;
  }}
  const opts={ClientType,reportDirectory:dir,log:()=>{}};
  await assert.rejects(main(args,opts),/HR export\/salary-sheet/);assert.equal(commits,0);
  await assert.rejects(main([...args,'--payroll-export-verified'],opts),/injected late failure/);
  assert.equal((await db.query("SELECT to_regclass('professional_attendance') IS NOT NULL AS old")).rows[0].old,true);
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');assert.equal(commits,0);
  fail=false;const applied=await main([...args,'--payroll-export-verified'],opts);assert.equal(commits,1);assert.equal(applied.naming.alreadyApplied,false);assert.equal(applied.payrollInputsVerified,true);
  assert.deepEqual(await protectedRows(db),before);
 }finally{await db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
});

test('fingerprint cursor-close failures fail verification without masking an earlier read failure',async()=>{
 const hash='0'.repeat(32);
 const client={query:async sql=>{if(sql.startsWith('FETCH'))return {rows:[{row_hash:hash}]};if(sql.startsWith('CLOSE'))throw Error('close failed');return {rows:[]};}};
 await assert.rejects(fullRowFingerprint(client,'attendance'),/close failed/);
 await assert.rejects(fullRowFingerprint({query:async sql=>{if(sql.startsWith('FETCH'))throw Error('read failed');if(sql.startsWith('CLOSE'))throw Error('close failed');return {rows:[]};}},'attendance'),/read failed/);
});

test('CLI automatically expands long-name capacity; rehearsal and late failures roll back schema and names together',async()=>{
 const db=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-cli-'));try{
  await db.exec("UPDATE sectors SET sector_name=repeat('P',95) WHERE sector_id=10");const before=await protectedRows(db);
  const envFile=path.join(dir,'fake.env');fs.writeFileSync(envFile,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  const args=['--env-file='+envFile,'--expected-host=fixture','--expected-database=postgres'];let fail=false;
  class ClientType{async connect(){}async end(){}async query(sql,params){
   if(fail&&sql.includes('ALTER COLUMN ward_id DROP NOT NULL'))throw Error('late capacity cutover failure');
   const result=await adapter(db).query(sql,params);return sql==='COMMIT'?{...result,command:'COMMIT'}:result;
  }}
  const opts={ClientType,reportDirectory:dir,log:()=>{}};
  const rehearsal=await main(args,opts);assert.equal(rehearsal.capacity.changed,true);
  const width=async()=>(await db.query("SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_name='wards' AND column_name='ward_name'")).rows[0].n;
  assert.equal(await width(),100);assert.equal((await db.query("SELECT to_regclass('ward_name_capacity_backup') AS backup")).rows[0].backup,null);
  const apply=['--apply','--maintenance-confirmed','--compatible-code-deployed','--payroll-export-verified'];
  fail=true;await assert.rejects(main([...args,...apply],opts),/late capacity cutover failure/);
  assert.equal(await width(),100);assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');
  fail=false;const applied=await main([...args,...apply],opts);assert.equal(applied.capacity.changed,true);assert.equal(applied.payrollInputsVerified,true);assert.equal(await width(),255);
  assert.equal((await db.query('SELECT ward_name FROM attendance_dashboard_view WHERE kothi_id=1008')).rows[0].ward_name,'P'.repeat(95)+', Solaris');
  assert.deepEqual(await protectedRows(db),before);
 }finally{await db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
});

test('standalone naming entry point also enforces payroll acknowledgement and rejects a confirmed commit rollback',async()=>{
 const naming=require('../scripts/migrate-self-attendance-names').main,db=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'naming-payroll-'));try{
  const file=path.join(dir,'fake.env');fs.writeFileSync(file,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  const args=['--env-file='+file,'--expected-host=fixture','--expected-database=postgres','--apply','--maintenance-confirmed'];let clients=0;
  class ClientType{constructor(){clients++;}async connect(){}async end(){}async query(sql,params){if(sql==='COMMIT'){await db.exec('ROLLBACK');return {command:'ROLLBACK',rows:[]};}return adapter(db).query(sql,params);}}
  const opts={ClientType,log:()=>{}};
  await assert.rejects(naming(args,opts),/HR export\/salary-sheet/);assert.equal(clients,0);
  await assert.rejects(naming([...args,'--preview-name'],opts),/Unknown/);assert.equal(clients,0);
  await assert.rejects(naming([...args,'--payroll-export-verified'],opts),/did not commit/);
  assert.equal((await naming(['--help'],opts)).mode,'HELP');
 }finally{await db.close();for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir);}
});
