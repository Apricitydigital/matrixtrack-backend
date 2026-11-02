'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadMigrationTarget,verifyConnectedTarget}=require('../utils/migrationTarget');
const env={DB_HOST:'fixture-db',DB_NAME:'fixture',DB_USER:'fixture-user',DB_PASSWORD:'fake-fixture-password'};
const args=['--expected-host=fixture-db','--expected-database=fixture'];
const missing=path.join(os.tmpdir(),'matrixtrack-absent-env-'+process.pid);
test('migration refuses wrong or missing host/database and unconfirmed maintenance apply',()=>{
 const opts={environment:env,defaultEnvFile:missing};
 assert.throws(()=>loadMigrationTarget([],opts),/expected-host/);
 assert.throws(()=>loadMigrationTarget(['--expected-host=fixture-db'],opts),/expected-database/);
 assert.throws(()=>loadMigrationTarget(['--expected-host=other','--expected-database=fixture'],opts),/expected-host/);
 assert.throws(()=>loadMigrationTarget([...args,'--apply'],opts),/maintenance-confirmed/);
 assert.equal(loadMigrationTarget([...args,'--apply','--maintenance-confirmed'],opts).database,'fixture');
});
test('deployment environment overrides local defaults; explicit env file is authoritative and never mixes credentials',()=>{
 const file=path.join(os.tmpdir(),'matrixtrack-migration-target-'+process.pid+'.env');
 fs.writeFileSync(file,'DB_HOST=file-db\nDB_NAME=file-database\nDB_USER=file-user\nDB_PASSWORD=fake-file-password\n');
 try{
  assert.equal(loadMigrationTarget(args,{environment:env,defaultEnvFile:file}).host,'fixture-db');
  const target=loadMigrationTarget(['--env-file='+file,'--expected-host=file-db','--expected-database=file-database'],{environment:env});
  assert.equal(target.host,'file-db');assert.equal(target.user,'file-user');
  assert.throws(()=>loadMigrationTarget([...args,'--env-file='+missing],{environment:env}),/does not exist/);
 }finally{fs.unlinkSync(file);}
});
test('migration checks actual connected database and rejects replica or mismatched database before BEGIN',async()=>{
 const target={host:'fixture-db',port:5432,database:'fixture'};
 const db=row=>({query:async sql=>{assert.match(sql,/current_database\(\)/);return {rows:[row]};}});
 await assert.rejects(verifyConnectedTarget(db({database:'other',replica:false}),target),/identity/);
 await assert.rejects(verifyConnectedTarget(db({database:'fixture',replica:true}),target),/primary/);
 assert.deepEqual(await verifyConnectedTarget(db({database:'fixture',replica:false}),target),target);
});
