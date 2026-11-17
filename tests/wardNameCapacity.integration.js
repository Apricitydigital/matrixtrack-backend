'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,adapter,protectedRows}=require('./helpers/wardNameFixture');
const {previewWardNames}=require('../utils/wardNameMigration');
const {previewWardNameCapacity,applyWardNameCapacity}=require('../utils/wardNameCapacity');
const {retireSectorMemberships,restoreSectorMemberships}=require('../utils/sectorRetirement');
async function plan(db){return previewWardNameCapacity(adapter(db),await previewWardNames(adapter(db)));}

test('capacity widens 100 to 255 while preserving every business/view row, ACL, comments and full names through cutover/rollback',async()=>{
 const db=await fixture();try{
  await db.exec(`CREATE ROLE payroll_reader;GRANT SELECT ON attendance_dashboard_view TO payroll_reader WITH GRANT OPTION;
   ALTER VIEW attendance_dashboard_view SET(security_barrier=true);
   COMMENT ON VIEW attendance_dashboard_view IS 'payroll view';COMMENT ON COLUMN attendance_dashboard_view.kothi_name IS 'site label';
   UPDATE sectors SET sector_name=repeat('P',95) WHERE sector_id=10`);
  const before=await protectedRows(db),raw=(await db.query('SELECT * FROM attendance_dashboard_view ORDER BY kothi_id')).rows;
  await db.exec('SET ROLE payroll_reader');const readerBefore=(await db.query('SELECT * FROM attendance_dashboard_view ORDER BY kothi_id')).rows;await db.exec('RESET ROLE');
  const preview=await plan(db);assert.equal(preview.required,true);assert.equal(preview.valid,true,JSON.stringify(preview.issues));
  await db.exec('BEGIN');const expanded=await applyWardNameCapacity(adapter(db),preview);
  assert.equal(expanded.changed,true);assert.deepEqual(expanded.before,expanded.after);assert.deepEqual(expanded.viewBefore,expanded.viewAfter);
  assert.deepEqual((await db.query('SELECT * FROM attendance_dashboard_view ORDER BY kothi_id')).rows,raw);
  await db.exec('SET ROLE payroll_reader');assert.deepEqual((await db.query('SELECT * FROM attendance_dashboard_view ORDER BY kothi_id')).rows,readerBefore);await db.exec('RESET ROLE');
  assert.equal((await previewWardNames(adapter(db))).valid,true);
  const applied=await retireSectorMemberships(adapter(db),()=>{},{combineWardNames:true,requireCompleteSchema:true});await db.exec('COMMIT');
  assert.deepEqual(applied.expectedAfter,applied.after);assert.deepEqual(await protectedRows(db),before);
  const name='P'.repeat(95)+', Solaris';assert.equal((await db.query('SELECT ward_name,kothi_name FROM attendance_dashboard_view WHERE kothi_id=1008')).rows[0].ward_name,name);
  assert.equal((await db.query("SELECT has_table_privilege('payroll_reader','attendance_dashboard_view','SELECT') AS allowed")).rows[0].allowed,true);
  assert.equal((await db.query("SELECT obj_description('attendance_dashboard_view'::regclass,'pg_class') AS comment")).rows[0].comment,'payroll view');
  assert.ok((await db.query("SELECT reloptions FROM pg_class WHERE oid='attendance_dashboard_view'::regclass")).rows[0].reloptions.includes('security_barrier=true'));
  await db.exec('BEGIN');await restoreSectorMemberships(adapter(db));await db.exec('COMMIT');
  assert.deepEqual(await protectedRows(db),before);assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');
  assert.equal((await db.query("SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_name='wards' AND column_name='ward_name'")).rows[0].n,255);
  assert.equal((await plan(db)).required,false);
 }finally{await db.close();}
});

test('capacity refuses unknown dependent views, column grants and DDL triggers without dropping anything',async()=>{
 const db=await fixture();try{
  await db.exec("UPDATE sectors SET sector_name=repeat('P',95) WHERE sector_id=10;CREATE VIEW unreviewed_payroll AS SELECT * FROM attendance_dashboard_view");
  const unknown=await plan(db);assert.equal(unknown.valid,false);assert.ok(unknown.issues.some(i=>i.includes('unreviewed_payroll')));
  await db.exec('BEGIN');await assert.rejects(applyWardNameCapacity(adapter(db),unknown),/requires review/);await db.exec('ROLLBACK');
  assert.ok((await db.query("SELECT to_regclass('attendance_dashboard_view') AS view")).rows[0].view);
  await db.exec('DROP VIEW unreviewed_payroll;CREATE ROLE narrow_reader;GRANT SELECT(kothi_name) ON attendance_dashboard_view TO narrow_reader');
  assert.ok((await plan(db)).issues.some(i=>i.includes('Column-level')));
  await db.exec('REVOKE SELECT(kothi_name) ON attendance_dashboard_view FROM narrow_reader');
  const p=await plan(db),base=adapter(db);
  await db.exec('BEGIN');await assert.rejects(applyWardNameCapacity({query:(sql,params)=>sql.includes('FROM pg_event_trigger')?Promise.resolve({rows:[{evtname:'guarded'}]}):base.query(sql,params)},p),/DDL event triggers/);await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('capacity failure restores original schema/views and does not overwrite its journal',async()=>{
 const db=await fixture();try{
  await db.exec("UPDATE sectors SET sector_name=repeat('P',95) WHERE sector_id=10");const p=await plan(db),before=await protectedRows(db),base=adapter(db);
  const broken={query:async(sql,params)=>{if(sql.startsWith('CREATE VIEW public.'))throw Error('injected recreate failure');return base.query(sql,params);}};
  await db.exec('BEGIN');await assert.rejects(applyWardNameCapacity(broken,p),/injected recreate failure/);await db.exec('ROLLBACK');
  assert.deepEqual(await protectedRows(db),before);assert.ok((await db.query("SELECT to_regclass('attendance_dashboard_view') AS view")).rows[0].view);
  assert.equal((await db.query("SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_name='wards' AND column_name='ward_name'")).rows[0].n,100);
  assert.equal((await db.query("SELECT to_regclass('ward_name_capacity_backup') AS backup")).rows[0].backup,null);
 }finally{await db.close();}
});
