'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {main}=require('../scripts/retire-sector-memberships');
const {fixture,adapter,protectedRows}=require('./helpers/wardNameFixture');

test('real migration CLI entry point previews read-only, rehearses/rolls back, automatically combines on apply, and restores names',async()=>{
 const db=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ward-name-cli-'));try{
  const envFile=path.join(dir,'fixture.env');fs.writeFileSync(envFile,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  const args=['--env-file='+envFile,'--expected-host=fixture','--expected-database=postgres'],queries=[];
  class ClientType{async connect(){}async end(){}async query(sql,params){queries.push(sql);const result=await adapter(db).query(sql,params);if(sql==='COMMIT')return {...result,command:'COMMIT'};return result;}}
  const opts={ClientType,reportDirectory:dir,log:()=>{}},before=await protectedRows(db);
  const preview=await main([...args,'--preview-names'],opts);assert.equal(preview.valid,true);assert.equal(preview.changedNames,3);
  assert.ok(queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));assert.ok(!queries.some(sql=>/^\s*(CREATE|ALTER|UPDATE|INSERT|DELETE|LOCK)\b/.test(sql)));
  const again=await main([...args,'--preview-names'],opts);assert.notEqual(again.reportPath,preview.reportPath);assert.ok(fs.existsSync(preview.reportPath));
  const rehearsal=await main(args,opts);assert.equal(rehearsal.combinedNames,3);assert.equal(rehearsal.mode,'REHEARSAL ROLLED BACK');
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');
  assert.equal((await db.query("SELECT to_regclass('ward_name_retirement_backup') AS name")).rows[0].name,null);
  const applyFlags=['--apply','--maintenance-confirmed','--compatible-code-deployed','--payroll-export-verified'];
  const applied=await main([...args,...applyFlags],opts);assert.equal(applied.combinedNames,3);assert.equal(applied.mode,'APPLIED');
  const restorePreview=await main([...args,'--preview-names','--rollback'],opts);assert.equal(restorePreview.changedNames,3);
  const restored=await main([...args,'--rollback',...applyFlags],opts);assert.equal(restored.restoredNames,3);
  assert.equal((await db.query('SELECT ward_name FROM wards WHERE ward_id=1008')).rows[0].ward_name,'Solaris');assert.deepEqual(await protectedRows(db),before);
  await assert.rejects(main([...args,'--preview-names','--apply'],opts),/read-only/);
 }finally{await db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
});

test('invalid CLI name preview saves issues without changing names or touching migration DDL',async()=>{
 const db=await fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'ward-name-cli-invalid-'));try{
  const envFile=path.join(dir,'fixture.env');fs.writeFileSync(envFile,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  await db.exec("INSERT INTO wards VALUES(2000,55,NULL,'Human Matrix + Solaris')");const queries=[];
  class ClientType{async connect(){}async end(){}query(sql,params){queries.push(sql);return adapter(db).query(sql,params);}}
  await assert.rejects(main(['--env-file='+envFile,'--expected-host=fixture','--expected-database=postgres','--preview-names'],{ClientType,reportDirectory:dir,log:()=>{}}),/preview saved with issues/);
  const report=JSON.parse(fs.readFileSync(path.join(dir,'ward-names-preview.json'),'utf8'));assert.equal(report.valid,false);assert.ok(report.issues.length);
  assert.ok(!queries.some(sql=>/^\s*(CREATE|ALTER|UPDATE|INSERT|DELETE|LOCK)\b/.test(sql)));
 }finally{await db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
});
