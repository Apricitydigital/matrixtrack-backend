'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,adapter,protectedRows}=require('./helpers/wardNameFixture');
const {previewWardNames}=require('../utils/wardNameMigration');
const {retireSectorMemberships,restoreSectorMemberships}=require('../utils/sectorRetirement');
const {importOptions,validateImport}=require('../utils/employeeBulkImport');
const migrate=db=>retireSectorMemberships(adapter(db),()=>{},{combineWardNames:true,requireCompleteSchema:true});
const names=async db=>(await db.query('SELECT ward_id,ward_name FROM wards ORDER BY ward_id')).rows;

test('read-only name preview combines actual parent labels, preserves IDs and skips missing/already-combined parents',async()=>{
 const db=await fixture();try{
  await db.exec("INSERT INTO sectors VALUES(32,55,'Head Office - HMS');INSERT INTO wards VALUES(1990,55,32,'Head Office- HMS')");
  const before=await names(db);await db.exec('BEGIN READ ONLY');const plan=await previewWardNames(adapter(db));await db.exec('ROLLBACK');
  assert.equal(plan.valid,true);assert.equal(plan.changedNames,3);assert.equal(plan.separator,', ');
  assert.equal(plan.rows.find(r=>r.ward_id===1008).proposed_name,'Human Matrix, Solaris');
  assert.equal(plan.rows.find(r=>r.ward_id===1621).proposed_name,'QA Site');
  assert.equal(plan.rows.find(r=>r.ward_id===1900).proposed_name,'Campus + Store');
  assert.equal(plan.rows.find(r=>r.ward_id===1901).proposed_name,'Same');
  assert.equal(plan.rows.find(r=>r.ward_id===1990).proposed_name,'Head Office- HMS');
  assert.deepEqual(await names(db),before);
  assert.equal((await db.query("SELECT to_regclass('ward_name_retirement_backup') AS name")).rows[0].name,null);
 }finally{await db.close();}
});

test('combined cutover preserves full employee/punch rows and visibility, imports old/new names, reruns, rolls back and reapplies',async()=>{
 const db=await fixture();try{
  const before=await protectedRows(db),originalNames=await names(db);await db.exec('BEGIN');const applied=await migrate(db);await db.exec('COMMIT');
  assert.equal(applied.combinedNames,3);assert.equal(applied.changed,5);assert.deepEqual(applied.expectedAfter,applied.after);
  assert.notDeepEqual(applied.before.wards,applied.after.wards);assert.deepEqual(applied.accessBefore,applied.accessAfter);
  assert.deepEqual(await protectedRows(db),before);
  assert.equal((await db.query('SELECT ward_name FROM attendance_dashboard_view WHERE kothi_id=1008')).rows[0].ward_name,'Human Matrix, Solaris');
  const originalBackup=(await db.query('SELECT ward_id,original_name,combined_name FROM ward_name_retirement_backup ORDER BY ward_id')).rows;
  const options=await importOptions(adapter(db),null,null);
  for(const site of ['Solaris','Human Matrix, Solaris','Human Matrix + Solaris','1008']){
   const validation=await validateImport(adapter(db),[{name:'New worker',emp_code:'NEW',no_personal_phone:'Yes',city:'1',zone:'55',kothi:site,department:'1',designation:'1'}],options,null,null);
   assert.equal(validation.can_import,true,JSON.stringify(validation.errors));assert.equal(validation.rows[0].kothi_id,1008);
  }
  const scoped=await importOptions(adapter(db),[1],[1569]);assert.ok(scoped.locations.every(row=>row.kothi_id===1569));
  await db.exec('BEGIN');const second=await migrate(db);await db.exec('COMMIT');assert.equal(second.combinedNames,0);assert.equal(second.changed,0);
  assert.deepEqual((await db.query('SELECT ward_id,original_name,combined_name FROM ward_name_retirement_backup ORDER BY ward_id')).rows,originalBackup);
  await db.exec('BEGIN');const restored=await restoreSectorMemberships(adapter(db));await db.exec('COMMIT');
  assert.equal(restored.restoredNames,3);assert.deepEqual(restored.expectedAfter,restored.after);assert.deepEqual(await names(db),originalNames);assert.deepEqual(await protectedRows(db),before);
  const restoredOptions=await importOptions(adapter(db),null,null);
  const workbook=await validateImport(adapter(db),[{name:'New',emp_code:'NEW',no_personal_phone:'Yes',city:'1',zone:'55',kothi:'Human Matrix, Solaris',department:'1',designation:'1'}],restoredOptions,null,null);
  assert.equal(workbook.can_import,true);
  await db.exec('BEGIN');const again=await migrate(db);await db.exec('COMMIT');assert.equal(again.combinedNames,3);assert.deepEqual(await protectedRows(db),before);
 }finally{await db.close();}
});

test('already-retired database uses frozen parent links without guessing a parent from overlapping IDs',async()=>{
 const db=await fixture();try{
  await db.exec("INSERT INTO wards VALUES(10,129,20,'Other physical Ward')");
  await db.exec('BEGIN');await retireSectorMemberships(adapter(db));await db.exec('COMMIT');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM wards WHERE sector_id IS NOT NULL')).rows[0].n,0);
  const plan=await previewWardNames(adapter(db));assert.equal(plan.rows.find(r=>r.ward_id===1008).proposed_name,'Human Matrix, Solaris');
  assert.equal(plan.rows.find(r=>r.ward_id===10).proposed_name,'IT Campus, Other physical Ward');
  await db.exec('BEGIN');const applied=await migrate(db);await db.exec('COMMIT');assert.equal(applied.changed,0);assert.equal(applied.combinedNames,4);
 }finally{await db.close();}
});

test('late protected-row corruption rolls back combined names, original parent map and name backup atomically',async()=>{
 const db=await fixture();try{
  const original=await names(db),before=await protectedRows(db),base=adapter(db);let injected=false;
  const client={query:async(sql,params)=>{const result=await base.query(sql,params);if(sql.includes('ALTER COLUMN ward_id DROP NOT NULL')&&!injected){await db.exec('UPDATE employee SET ward_id=1010 WHERE emp_id=7');injected=true;}return result;}};
  await db.exec('BEGIN');await assert.rejects(retireSectorMemberships(client,()=>{},{combineWardNames:true}),/Protected employee\/history\/access data changed/);await db.exec('ROLLBACK');
  assert.equal(injected,true);assert.deepEqual(await names(db),original);assert.deepEqual(await protectedRows(db),before);
  assert.equal((await db.query("SELECT to_regclass('ward_name_retirement_backup') AS name")).rows[0].name,null);
  assert.equal((await db.query('SELECT sector_id FROM wards WHERE ward_id=1008')).rows[0].sector_id,10);
 }finally{await db.close();}
});

test('duplicate, overlong, blank or unknown parent names are reported and block all name updates',async()=>{
 const db=await fixture();try{
  await db.exec("INSERT INTO wards VALUES(2000,55,NULL,'Human Matrix, Solaris');UPDATE sectors SET sector_name=repeat('x',95) WHERE sector_id=20;UPDATE sectors SET sector_name=' ' WHERE sector_id=31;UPDATE wards SET sector_id=999 WHERE ward_id=1900");
  const plan=await previewWardNames(adapter(db));assert.equal(plan.valid,false);
  for(const type of ['duplicate_name','name_too_long','blank_name','invalid_parent'])assert.ok(plan.issues.some(issue=>issue.type===type),type);
  const before=await names(db);await db.exec('BEGIN');await assert.rejects(migrate(db));await db.exec('ROLLBACK');assert.deepEqual(await names(db),before);
 }finally{await db.close();}
});

test('global unique-name constraints and unknown expression indexes cannot be bypassed by a Zone-only check',async()=>{
 const db=await fixture();try{
  await db.exec("CREATE UNIQUE INDEX global_ward_names ON wards(ward_name);INSERT INTO wards VALUES(2000,129,NULL,'Human Matrix, Solaris')");
  const global=await previewWardNames(adapter(db));assert.ok(global.issues.some(issue=>issue.type==='duplicate_name'));
  await db.exec('DROP INDEX global_ward_names;CREATE UNIQUE INDEX normalized_ward_names ON wards(lower(ward_name),zone_id)');
  const expression=await previewWardNames(adapter(db));assert.ok(expression.issues.some(issue=>issue.type==='unreviewed_name_index'));
 }finally{await db.close();}
});

test('rollback/reapply refuse to overwrite later HR edits or new Ward name conflicts',async()=>{
 const db=await fixture();try{
  await db.exec('BEGIN');await migrate(db);await db.exec('COMMIT');
  await db.exec("UPDATE wards SET ward_name='HR renamed office' WHERE ward_id=1008");await db.exec('BEGIN');
  await assert.rejects(restoreSectorMemberships(adapter(db)),/name preview/);await db.exec('ROLLBACK;BEGIN');
  await assert.rejects(migrate(db),/name preview/);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'HR renamed office');
  await db.exec("UPDATE wards SET ward_name='Human Matrix, Solaris' WHERE ward_id=1008;INSERT INTO wards VALUES(2000,55,NULL,'Solaris')");await db.exec('BEGIN');
  await assert.rejects(restoreSectorMemberships(adapter(db)),/name preview/);await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('old import aliases remain scoped and ambiguous aliases never silently choose another physical Ward',async()=>{
 const db=await fixture();try{
  await db.exec('BEGIN');await migrate(db);await db.exec('COMMIT');await db.exec("INSERT INTO wards VALUES(2000,55,NULL,'Solaris')");
  const options=await importOptions(adapter(db),null,null);
  const input={name:'New',emp_code:'NEW',no_personal_phone:'Yes',city:'1',zone:'55',kothi:'Solaris',department:'1',designation:'1'};
  assert.equal((await validateImport(adapter(db),[input],options,null,null)).can_import,false);
  const exact=await validateImport(adapter(db),[{...input,kothi:'1008'}],options,null,null);assert.equal(exact.can_import,true);assert.equal(exact.rows[0].kothi_id,1008);
  const scoped=await importOptions(adapter(db),[1],[2000]);assert.equal((await validateImport(adapter(db),[{...input,kothi:'1008'}],scoped,[1],[2000])).can_import,false);
 }finally{await db.close();}
});
