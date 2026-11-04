'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fixture,adapter,protectedRows}=require('./helpers/wardNameFixture');
const {previewWardNames,applyWardNamePlan}=require('../utils/wardNameMigration');
const {retireSectorMemberships,restoreSectorMemberships}=require('../utils/sectorRetirement');
const {main}=require('../scripts/retire-sector-memberships');
const migrate=db=>retireSectorMemberships(adapter(db),()=>{},{combineWardNames:true,requireCompleteSchema:true});
function cli(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ward-name-edges-')),file=path.join(dir,'fixture.env');
 fs.writeFileSync(file,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
 t.after(()=>{for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir);});
 return {dir,args:['--env-file='+file,'--expected-host=fixture','--expected-database=postgres'],apply:['--apply','--compatible-code-deployed','--maintenance-confirmed','--payroll-export-verified']};}

test('Unicode length boundaries and quoted/SQL-looking labels preserve exact data without truncation or SQL execution',async()=>{
 const db=await fixture();try{
  await db.query('UPDATE sectors SET sector_name=$1 WHERE sector_id=10',['P'.repeat(48)]);
  await db.query('UPDATE wards SET ward_name=$1 WHERE ward_id=1008',['🏠'.repeat(50)]);
  const exact=await previewWardNames(adapter(db));assert.equal(exact.valid,true);const proposed=exact.rows.find(r=>r.ward_id===1008).proposed_name;
  assert.equal(Array.from(proposed).length,100);assert.equal((await db.query('SELECT char_length($1::text) AS n',[proposed])).rows[0].n,100);
  await db.query('UPDATE sectors SET sector_name=$1 WHERE sector_id=10',['P'.repeat(49)]);
  const over=await previewWardNames(adapter(db));assert.equal(over.valid,false);assert.ok(over.issues.some(i=>i.type==='name_too_long'&&i.ward_id===1008));
  assert.equal(over.requiredNameCapacity[0].minimumRequired,101);
  assert.equal(Array.from((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name).length,50);
  const parent="O'Brien",child="Gate'); DROP TABLE attendance; -- 🏠";
  await db.query('UPDATE sectors SET sector_name=$1 WHERE sector_id=10',[parent]);await db.query('UPDATE wards SET ward_name=$1 WHERE ward_id=1008',[child]);
  const before=await protectedRows(db);await db.exec('BEGIN');await migrate(db);await db.exec('COMMIT');
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,parent+', '+child);
  assert.equal((await db.query('SELECT original_name FROM ward_name_retirement_backup WHERE ward_id=1008')).rows[0].original_name,child);
  assert.deepEqual(await protectedRows(db),before);
 }finally{await db.close();}
});

test('name preview rejects unknown geography, changed archived Zone and conflicting live/archive parents',async()=>{
 const db=await fixture();try{
  await db.exec('BEGIN;UPDATE wards SET zone_id=999 WHERE ward_id=1621');
  assert.ok((await previewWardNames(adapter(db))).issues.some(i=>i.type==='invalid_geography'));await db.exec('ROLLBACK');
  await db.exec('BEGIN');await retireSectorMemberships(adapter(db));await db.exec('COMMIT');
  await db.exec('BEGIN;UPDATE wards SET zone_id=129 WHERE ward_id=1008');
  assert.ok((await previewWardNames(adapter(db))).issues.some(i=>i.type==='changed_parent_zone'));await db.exec('ROLLBACK');
  await db.exec('BEGIN;ALTER TABLE wards DROP CONSTRAINT wards_retired_sector_null;UPDATE wards SET sector_id=31 WHERE ward_id=1008');
  assert.ok((await previewWardNames(adapter(db))).issues.some(i=>i.type==='conflicting_parent_backup'));await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('name, Zone or parent changes after preview cannot be overwritten by a stale name plan',async()=>{
 const db=await fixture();try{
  const base=adapter(db),before=await protectedRows(db);
  for(const update of ["ward_name='HR changed name'",'zone_id=129','sector_id=31']){
   const plan=await previewWardNames(base);assert.equal(plan.valid,true);await db.exec('UPDATE wards SET '+update+' WHERE ward_id=1008');
   const changed=(await db.query('SELECT ward_name,zone_id,sector_id FROM wards WHERE ward_id=1008')).rows;
   await db.exec('BEGIN');await assert.rejects(applyWardNamePlan(base,plan),/state changed since preview/);await db.exec('ROLLBACK');
   assert.deepEqual((await db.query('SELECT ward_name,zone_id,sector_id FROM wards WHERE ward_id=1008')).rows,changed);assert.deepEqual(await protectedRows(db),before);
   await db.exec("UPDATE wards SET ward_name='Solaris',zone_id=55,sector_id=10 WHERE ward_id=1008");
  }
 }finally{await db.close();}
});

test('unexpected edits to untouched Wards or saved name metadata fail and roll back the complete cutover',async()=>{
 const db=await fixture();try{
  const before=await protectedRows(db),base=adapter(db);
  for(const tamper of ['ward','backup']){
   let injected=false;const client={query:async(sql,params)=>{
    const result=await base.query(sql,params);
    if(!injected&&sql.startsWith('UPDATE ward_name_retirement_backup SET active=TRUE')){
     await db.exec(tamper==='ward'?"UPDATE wards SET ward_name='Unexpected edit' WHERE ward_id=1621":"UPDATE ward_name_retirement_backup SET original_name='Tampered' WHERE ward_id=1008");injected=true;
    }return result;
   }};
   await db.exec('BEGIN');await assert.rejects(retireSectorMemberships(client,()=>{},{combineWardNames:true}),/Protected employee\/history\/access data changed|Saved Ward name state/);await db.exec('ROLLBACK');
   assert.equal(injected,true);assert.deepEqual(await protectedRows(db),before);
   assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1621')).rows[0].ward_name,'QA Site');
   assert.equal((await db.query("SELECT to_regclass('ward_name_retirement_backup') AS name")).rows[0].name,null);
  }
 }finally{await db.close();}
});

test('empty Ward directory is safe and does not create an unnecessary name backup',async()=>{
 const db=await fixture();try{
  await db.exec('DELETE FROM attendance;DELETE FROM self_attendance_records;DELETE FROM employee;DELETE FROM self_attendance_employees;DELETE FROM self_punch_requests;DELETE FROM supervisor_ward;DELETE FROM wards');
  const before=await protectedRows(db),plan=await previewWardNames(adapter(db));assert.equal(plan.valid,true);assert.equal(plan.changedNames,0);
  await db.exec('BEGIN');const applied=await migrate(db);await db.exec('COMMIT');assert.equal(applied.combinedNames,0);assert.deepEqual(await protectedRows(db),before);
  assert.equal((await db.query("SELECT to_regclass('ward_name_retirement_backup') AS name")).rows[0].name,null);
 }finally{await db.close();}
});

test('blank, cosmetic-prefix, case-folded duplicate and name-transition boundaries are handled before updates',async()=>{
 const db=await fixture();try{
  await db.exec("BEGIN;UPDATE wards SET ward_name=E'  \\t ' WHERE ward_id=1621");
  assert.ok((await previewWardNames(adapter(db))).issues.some(i=>i.type==='blank_name'&&i.ward_id===1621));await db.exec('ROLLBACK');
  for(const label of ['  CAMPUS+Store  ','  CAMPUS , Store  ']){
   await db.exec('BEGIN');await db.query('UPDATE wards SET ward_name=$1 WHERE ward_id=1900',[label]);
   const cosmetic=await previewWardNames(adapter(db));assert.equal(cosmetic.valid,true);assert.equal(cosmetic.rows.find(r=>r.ward_id===1900).action,'keep_already_combined');await db.exec('ROLLBACK');
  }
  await db.exec("BEGIN;INSERT INTO wards VALUES(2000,55,NULL,'human matrix, SOLARIS')");
  assert.ok((await previewWardNames(adapter(db))).issues.some(i=>i.type==='duplicate_name'));await db.exec('ROLLBACK');
  await db.exec("BEGIN;INSERT INTO wards VALUES(2000,55,31,'Human Matrix, Solaris')");
  const transition=await previewWardNames(adapter(db));assert.equal(transition.valid,false);
  assert.ok(transition.issues.some(i=>i.type==='name_transition_conflict'));assert.ok(!transition.issues.some(i=>i.type==='duplicate_name'));
  await assert.rejects(migrate(db),/name preview/);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');
 }finally{await db.close();}
});

test('enabled backup-row triggers cannot corrupt the original-name journal during restoration',async()=>{
 const db=await fixture();try{
  await db.exec('BEGIN');await migrate(db);await db.exec('COMMIT');const before=await protectedRows(db);
  for(const damage of ['DELETE FROM ward_sector_retirement_backup WHERE ward_id=1008','UPDATE ward_sector_retirement_backup SET sector_id=31 WHERE ward_id=1008']){
   await db.exec('BEGIN');await db.exec(damage);
   assert.ok((await previewWardNames(adapter(db),{restore:true})).issues.some(i=>i.type==='inconsistent_name_parent_backup'));
   await assert.rejects(restoreSectorMemberships(adapter(db)),/name preview/);await db.exec('ROLLBACK');
   assert.deepEqual(await protectedRows(db),before);
  }
  await db.exec(`CREATE FUNCTION tamper_name_backup() RETURNS TRIGGER LANGUAGE plpgsql AS $$BEGIN NEW.original_name:='Tampered';RETURN NEW;END;$$;
   CREATE TRIGGER tamper_names BEFORE UPDATE ON ward_name_retirement_backup FOR EACH ROW EXECUTE FUNCTION tamper_name_backup()`);
  await db.exec('BEGIN');await assert.rejects(restoreSectorMemberships(adapter(db)),/backup triggers/);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT original_name FROM ward_name_retirement_backup WHERE ward_id=1008')).rows[0].original_name,'Solaris');
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Human Matrix, Solaris');
  assert.deepEqual(await protectedRows(db),before);
  await db.exec('DROP TRIGGER tamper_names ON ward_name_retirement_backup;BEGIN');await restoreSectorMemberships(adapter(db));await db.exec('COMMIT');
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');
 }finally{await db.close();}
});

test('CLI rejects misspelled, duplicate and malformed flags before constructing a DB client',async t=>{
 const c=cli(t);let connections=0;class ClientType{constructor(){connections++;throw Error('DB must not be constructed');}}
 const opts={ClientType,reportDirectory:c.dir,log:()=>{}};
 for(const extra of [['--preview-name'],['--preview-names=false'],['--force'],['--apply=false'],['--expected-host=fixture'],['--report='],['--env-file=']])
  await assert.rejects(main([...c.args,...extra],opts),/Unknown|Duplicate|requires a value|Invalid/);
 assert.equal(connections,0);
 const help=await main(['--help'],opts);assert.equal(help.mode,'HELP');assert.equal(connections,0);
});

test('cleanup errors cannot mask the primary operation failure or hide a successful commit',async t=>{
 const c=cli(t),db=await fixture();try{
  class ClientType{async connect(){}async end(){throw Error('cleanup failure');}async query(sql,params){
   const result=await adapter(db).query(sql,params);return sql==='COMMIT'?{...result,command:'COMMIT'}:result;
  }}
  const opts={ClientType,reportDirectory:c.dir,log:()=>{}};
  await assert.rejects(main([...c.args,...c.apply],opts),/changes committed; connection cleanup failed/);
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Human Matrix, Solaris');
  assert.ok(fs.readdirSync(c.dir).some(f=>f==='sector-retirement-applied.json'));
  class BrokenClient extends ClientType{async query(){throw Error('primary query failure');}}
  await assert.rejects(main([...c.args,'--preview-names'],{...opts,ClientType:BrokenClient}),/primary query failure/);
 }finally{await db.close();}
});

test('lost COMMIT response is reported as uncertain; confirmed ROLLBACK never becomes an APPLIED result',async t=>{
 const c=cli(t);
 for(const outcome of ['lost_before','lost_after','rolled_back']){
  const db=await fixture();try{
   class ClientType{async connect(){}async end(){await db.exec('ROLLBACK');}async query(sql,params){
    if(sql==='COMMIT'){
     if(outcome==='lost_before')throw Error('response lost');
     if(outcome==='lost_after'){await db.exec('COMMIT');throw Error('response lost');}
     await db.exec('ROLLBACK');return {command:'ROLLBACK',rows:[]};
    }return adapter(db).query(sql,params);
   }}
   await assert.rejects(main([...c.args,...c.apply],{ClientType,reportDirectory:c.dir,log:()=>{}}),outcome==='rolled_back'?/did not commit/:/Commit outcome uncertain/);
   const name=(await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name;
   assert.equal(name,outcome==='lost_after'?'Human Matrix, Solaris':'Solaris');
   assert.ok(!fs.readdirSync(c.dir).some(f=>f.includes('sector-retirement-applied')));
  }finally{await db.close();}
 }
});
