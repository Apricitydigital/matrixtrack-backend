'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {beginReviewedDmsCutover,reviewInactiveDms,assertEventTriggerSafety,auditedBody}=require('../utils/dmsCutoverGuard');
const target={host:'fixture.rds.amazonaws.com',port:5432,database:'postgres'};
const cloud=()=>({region:'ap-south-1',profile:'fixture',identity:{Account:'887850856172'},instances:[{Host:target.host,Port:5432,Engine:'postgres',Status:'available',Arn:'arn:aws:rds:ap-south-1:887850856172:db:fixture'}],endpoints:[],tasks:[],replications:[],dataMigrations:[]});
async function fixture(body=auditedBody){
 const db=new PGlite();await db.exec(`CREATE TABLE original_users(id int PRIMARY KEY);INSERT INTO original_users VALUES(1);
 CREATE TABLE awsdms_ddl_audit(c_key bigserial PRIMARY KEY,c_time timestamptz,c_user text,c_txn text,c_tag text,c_oid int,c_schema text,c_schema2 text,c_ddl text);
 CREATE FUNCTION public.awsdms_intercept_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $dms$${body}$dms$;
 CREATE EVENT TRIGGER awsdms_intercept_ddl ON ddl_command_end EXECUTE FUNCTION public.awsdms_intercept_ddl();`);
 const client={query:async(sql,params)=>params?db.query(sql,params):(await db.exec(sql)).at(-1)||{rows:[]}};
 return {db,client};
}
test('reviewed inactive DMS audit stays enabled through DDL and commit without changing users',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('BEGIN');const review=await beginReviewedDmsCutover(client,target,{cloudReader:async()=>cloud()});
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');
  await db.exec('CREATE TABLE cutover_marker(id int)');await assertEventTriggerSafety(client,review);await db.exec('COMMIT');
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');
  assert.deepEqual((await db.query('SELECT * FROM original_users')).rows,[{id:1}]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM awsdms_ddl_audit')).rows[0].n,0);
  assert.ok(Number((await db.query('SELECT last_value FROM awsdms_ddl_audit_c_key_seq')).rows[0].last_value)>=1);
 }finally{await db.close();}
});
test('late failure rolls migration DDL back while the DMS guard remains enabled',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('BEGIN');await beginReviewedDmsCutover(client,target,{cloudReader:async()=>cloud()});await db.exec('CREATE TABLE partial_cutover(id int)');await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');
  assert.equal((await db.query("SELECT to_regclass('partial_cutover') AS n")).rows[0].n,null);
 }finally{await db.close();}
});
test('existing DMS migrations and mismatched AWS ownership fail before changing the trigger',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('BEGIN');const active=cloud();active.tasks=[{Id:'active',Status:'running'}];
  await assert.rejects(beginReviewedDmsCutover(client,target,{cloudReader:async()=>active}),/migration resources exist/);
  const wrong=cloud();wrong.identity.Account='111111111111';
  await assert.rejects(reviewInactiveDms(client,target,{cloudReader:async()=>wrong}),/exact available production RDS/);
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');await db.exec('ROLLBACK');
 }finally{await db.close();}
});
test('an unexpected DMS function body is refused under the reviewed-audit option',async()=>{
 const {db,client}=await fixture('BEGIN RETURN; END;');try{
  await db.exec('BEGIN');await assert.rejects(beginReviewedDmsCutover(client,target,{cloudReader:async()=>cloud()}),/definition differs/);await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');
 }finally{await db.close();}
});
test('configured replication or another database client blocks a reviewed DMS cutover',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('BEGIN');const slots={query:(sql,params)=>sql.includes('FROM pg_replication_slots')?Promise.resolve({rows:[{slot_name:'real_replication'}]}):client.query(sql,params)};
  await assert.rejects(beginReviewedDmsCutover(slots,target,{cloudReader:async()=>cloud()}),/replication is configured/);
  const writers={query:(sql,params)=>sql.includes('FROM pg_stat_activity')?Promise.resolve({rows:[{pid:999}]}):client.query(sql,params)};
  await assert.rejects(beginReviewedDmsCutover(writers,target,{cloudReader:async()=>cloud()}),/Stop every database client/);
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');await db.exec('ROLLBACK');
 }finally{await db.close();}
});
test('audit rows are never silently deleted and serialized reviews cannot authorize DDL',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('BEGIN');const review=await beginReviewedDmsCutover(client,target,{cloudReader:async()=>cloud()});
  await assert.rejects(assertEventTriggerSafety(client,JSON.parse(JSON.stringify(review))),/Review enabled database event triggers/);
  await db.exec('ROLLBACK');await db.exec('INSERT INTO awsdms_ddl_audit DEFAULT VALUES');await db.exec('BEGIN');
  await assert.rejects(reviewInactiveDms(client,target,{cloudReader:async()=>cloud()}),/Existing DMS audit rows/);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM awsdms_ddl_audit')).rows[0].n,1);
 }finally{await db.close();}
});
test('one-shot shadow/naming/capacity/Ward cutover keeps the audited DMS trigger enabled on rehearsal and commit',async()=>{
 const fs=require('fs'),path=require('path'),os=require('os');
 const {fixture:wardFixture,adapter,protectedRows}=require('./helpers/wardNameFixture');
 const {main}=require('../scripts/retire-sector-memberships');
 const db=await wardFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'reviewed-dms-cutover-'));
 try{
  const before=await protectedRows(db);
  await db.exec(`INSERT INTO sectors VALUES(99,55,'${'S'.repeat(80)}');INSERT INTO wards VALUES(9999,55,99,'${'W'.repeat(30)}');
   CREATE TABLE empty_people(LIKE self_attendance_employees INCLUDING ALL);
   CREATE TABLE empty_records(LIKE self_attendance_records INCLUDING ALL);
   ALTER TABLE self_attendance_employees RENAME TO professional_employees;
   ALTER TABLE self_attendance_records RENAME TO professional_attendance;
   ALTER TABLE professional_attendance RENAME COLUMN self_attendance_id TO professional_id;
   ALTER TABLE empty_people RENAME TO self_attendance_employees;
   ALTER TABLE empty_records RENAME TO self_attendance_records;
   CREATE TABLE awsdms_ddl_audit(c_key bigserial PRIMARY KEY,c_time timestamptz,c_user text,c_txn text,c_tag text,c_oid int,c_schema text,c_schema2 text,c_ddl text);
   CREATE FUNCTION public.awsdms_intercept_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $dms$${auditedBody}$dms$;
   CREATE EVENT TRIGGER awsdms_intercept_ddl ON ddl_command_end EXECUTE FUNCTION public.awsdms_intercept_ddl();`);
  const envFile=path.join(dir,'fixture.env');fs.writeFileSync(envFile,'DB_HOST='+target.host+'\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  class ClientType{async connect(){}async end(){}async query(sql,params){const r=await adapter(db).query(sql,params);return {...r,rowCount:r.affectedRows,command:sql==='COMMIT'?'COMMIT':r.command};}}
  const args=['--env-file='+envFile,'--expected-host='+target.host,'--expected-database=postgres','--include-self-attendance-rename','--archive-unused-canonical','--review-inactive-dms','--maintenance-confirmed'];
  const opts={ClientType,reportDirectory:dir,log:()=>{},dmsCloudReader:async()=>cloud()};
  const rehearsal=await main(args,opts);assert.equal(rehearsal.mode,'REHEARSAL ROLLED BACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM self_attendance_records')).rows[0].n,0);
  const applied=await main([...args,'--apply','--compatible-code-deployed','--payroll-export-verified'],opts);
  assert.equal(applied.dmsReview.enabledStatePreserved,true);assert.equal(applied.capacity.changed,true);
  assert.equal(applied.shadowArchive.tables.length,2);assert.equal(applied.protectedDataUnchanged,true);
  assert.deepEqual(await protectedRows(db),before);
  assert.equal((await db.query("SELECT evtenabled FROM pg_event_trigger WHERE evtname='awsdms_intercept_ddl'")).rows[0].evtenabled,'O');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM awsdms_ddl_audit')).rows[0].n,0);
 }finally{await db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
});
