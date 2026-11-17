'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {inspectShadowSchema,archiveShadowSchema}=require('../utils/selfAttendanceShadowSchema');
const {renameSelfAttendance}=require('../utils/selfAttendanceRenameMigration');
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE professional_employees(id uuid PRIMARY KEY,full_name text);
 CREATE TABLE professional_attendance(id int PRIMARY KEY,professional_id uuid REFERENCES professional_employees,date date,punch_in timestamptz);
 CREATE TABLE self_attendance_employees(id uuid PRIMARY KEY,full_name text);
 CREATE TABLE self_attendance_records(id int PRIMARY KEY,self_attendance_id uuid REFERENCES self_attendance_employees,date date,punch_in timestamptz);
 CREATE TABLE professional_feature_settings(id int PRIMARY KEY,enabled boolean);
 CREATE TABLE self_attendance_feature_settings(id int PRIMARY KEY,enabled boolean);
 INSERT INTO professional_feature_settings VALUES(1,true);
 INSERT INTO self_attendance_feature_settings VALUES(1,false);
 INSERT INTO professional_employees VALUES('11111111-1111-4111-8111-111111111111','Original');
 INSERT INTO professional_attendance VALUES(5,'11111111-1111-4111-8111-111111111111','2026-11-17','2026-11-17T04:00:00Z');
 CREATE FUNCTION professional_is_paid_day(person uuid,on_date date) RETURNS boolean LANGUAGE sql AS 'SELECT true';
 CREATE FUNCTION self_attendance_is_paid_day(person uuid,on_date date) RETURNS boolean LANGUAGE sql AS 'SELECT false';`);
 const client={query:async(sql,params)=>{const r=params?await db.query(sql,params):(await db.exec(sql)).at(-1)||{rows:[]};return {...r,rowCount:r.affectedRows};}};
 return {db,client};
}
test('shadow archive keeps settings, table identity and original attendance through a real naming cutover',async()=>{
 const {db,client}=await fixture();
 try{
  const old=(await db.query("SELECT 'professional_attendance'::regclass::oid AS id")).rows[0].id;
  const shadow=(await db.query("SELECT 'self_attendance_records'::regclass::oid AS id")).rows[0].id;
  await db.exec('BEGIN');const plan=await inspectShadowSchema(client);
  const result=await archiveShadowSchema(client,{schema:'cutover_shadow',expectedPlan:plan});
  assert.equal(result.preserved,true);assert.equal(result.functions.length,1);
  await renameSelfAttendance(client);await db.exec('COMMIT');
  assert.equal((await db.query("SELECT 'self_attendance_records'::regclass::oid AS id")).rows[0].id,old);
  assert.equal((await db.query("SELECT 'cutover_shadow.self_attendance_records'::regclass::oid AS id")).rows[0].id,shadow);
  assert.equal((await db.query('SELECT id FROM self_attendance_records')).rows[0].id,5);
  assert.equal((await db.query('SELECT enabled FROM self_attendance_feature_settings')).rows[0].enabled,true);
  assert.equal((await db.query('SELECT enabled FROM cutover_shadow.self_attendance_feature_settings')).rows[0].enabled,false);
 }finally{await db.close();}
});
test('late failure rolls the archive and the naming changes back together',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('BEGIN');await archiveShadowSchema(client,{schema:'cutover_shadow'});await renameSelfAttendance(client);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM self_attendance_records')).rows[0].n,0);
  assert.equal((await db.query("SELECT to_regnamespace('cutover_shadow') AS n")).rows[0].n,null);
 }finally{await db.close();}
});
test('real canonical employee data blocks archival before any schema change',async()=>{
 const {db,client}=await fixture();try{
  await db.exec("INSERT INTO self_attendance_employees VALUES('22222222-2222-4222-8222-222222222222','Existing')");await db.exec('BEGIN');
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),/requires reconciliation/);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM self_attendance_employees')).rows[0].n,1);
 }finally{await db.close();}
});
test('external foreign keys and views prevent an archive that would strand consumers',async()=>{
 const {db,client}=await fixture();try{
  await db.exec('CREATE TABLE unrelated(id int,self_id uuid REFERENCES self_attendance_employees);CREATE VIEW canonical_report AS SELECT id FROM self_attendance_records');await db.exec('BEGIN');
  const plan=await inspectShadowSchema(client);assert.deepEqual(plan.issues.map(i=>i.type).sort(),['external_foreign_key','external_view']);
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),/requires reconciliation/);await db.exec('ROLLBACK');
 }finally{await db.close();}
});
test('a stale settings preview cannot archive later changed settings',async()=>{
 const {db,client}=await fixture();try{
  const plan=await inspectShadowSchema(client);await db.exec('UPDATE self_attendance_feature_settings SET enabled=true');await db.exec('BEGIN');
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow',expectedPlan:plan}),/changed after preview/);await db.exec('ROLLBACK');
 }finally{await db.close();}
});
async function permissionFixture(db){
 await db.exec(`CREATE TABLE permissions(id int PRIMARY KEY,module text,action text,label text,UNIQUE(module,action));
 CREATE TABLE role_permissions(role_id int,permission_id int REFERENCES permissions,PRIMARY KEY(role_id,permission_id));
 CREATE TABLE user_permissions(user_id int,permission_id int REFERENCES permissions,city_id int,PRIMARY KEY(user_id,permission_id));
 INSERT INTO permissions VALUES(10,'professional-weekly-off','view','Original'),(20,'self-attendance-weekly-off','view',NULL);
 INSERT INTO role_permissions VALUES(7,10);INSERT INTO user_permissions VALUES(9,10,3);`);
}
test('unassigned duplicate permission is archived while active IDs and all grants survive naming',async()=>{
 const {db,client}=await fixture();try{
  await permissionFixture(db);await db.exec('BEGIN');
  const archived=await archiveShadowSchema(client,{schema:'cutover_shadow'});assert.equal(archived.permissions.length,1);
  await renameSelfAttendance(client);await db.exec('COMMIT');
  assert.deepEqual((await db.query('SELECT * FROM role_permissions')).rows,[{role_id:7,permission_id:10}]);
  assert.deepEqual((await db.query('SELECT * FROM user_permissions')).rows,[{user_id:9,permission_id:10,city_id:3}]);
  assert.deepEqual((await db.query('SELECT id,module FROM permissions')).rows,[{id:10,module:'self-attendance-weekly-off'}]);
  assert.equal((await db.query('SELECT id FROM cutover_shadow.permissions_shadow')).rows[0].id,20);
 }finally{await db.close();}
});
test('an assigned duplicate permission fails closed instead of changing or cascading any grant',async()=>{
 const {db,client}=await fixture();try{
  await permissionFixture(db);await db.exec('INSERT INTO user_permissions VALUES(11,20,4)');await db.exec('BEGIN');
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),error=>error.details.some(i=>i.type==='assigned_shadow_permission'));
  await db.exec('ROLLBACK');assert.equal((await db.query('SELECT count(*)::int AS n FROM user_permissions')).rows[0].n,2);
 }finally{await db.close();}
});
test('empty duplicate department is backed up without changing active department/designation IDs',async()=>{
 const {db,client}=await fixture();try{
  await db.exec(`CREATE TABLE department(department_id int PRIMARY KEY,department_name text UNIQUE);
   CREATE TABLE designation(designation_id int PRIMARY KEY,designation_name text,department_id int REFERENCES department);
   CREATE TABLE employee(emp_id int PRIMARY KEY,designation_id int REFERENCES designation);
   INSERT INTO department VALUES(54,'Professional'),(55,'Self Attendance');
   INSERT INTO designation VALUES(74,'Professional',54);INSERT INTO employee VALUES(42,74);`);
  await db.exec('BEGIN');const archived=await archiveShadowSchema(client,{schema:'cutover_shadow'});
  assert.equal(archived.departments.length,1);await renameSelfAttendance(client);await db.exec('COMMIT');
  assert.deepEqual((await db.query('SELECT * FROM employee')).rows,[{emp_id:42,designation_id:74}]);
  assert.deepEqual((await db.query('SELECT * FROM department')).rows,[{department_id:54,department_name:'Self Attendance'}]);
  assert.equal((await db.query('SELECT department_id FROM cutover_shadow.department_shadow')).rows[0].department_id,55);
 }finally{await db.close();}
});
test('an in-use canonical department cannot be removed or cascade-delete its designations',async()=>{
 const {db,client}=await fixture();try{
  await db.exec(`CREATE TABLE department(department_id int PRIMARY KEY,department_name text UNIQUE);
   CREATE TABLE designation(designation_id int PRIMARY KEY,designation_name text,department_id int REFERENCES department ON DELETE CASCADE);
   CREATE TABLE employee(emp_id int PRIMARY KEY,designation_id int REFERENCES designation ON DELETE CASCADE);
   INSERT INTO department VALUES(54,'Professional'),(55,'Self Attendance');INSERT INTO designation VALUES(75,'Head',54),(99,'Head',55);INSERT INTO employee VALUES(42,99);`);
  await db.exec('BEGIN');await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),error=>error.details.some(i=>i.type==='assigned_shadow_designation'));
  await db.exec('ROLLBACK');assert.equal((await db.query('SELECT count(*)::int AS n FROM designation')).rows[0].n,2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM employee')).rows[0].n,1);
 }finally{await db.close();}
});
test('unused duplicate designation configuration is archived while the assigned original remains intact',async()=>{
 const {db,client}=await fixture();try{
  await db.exec(`CREATE TABLE department(department_id int PRIMARY KEY,department_name text UNIQUE);
   CREATE TABLE designation(designation_id int PRIMARY KEY,designation_name text,department_id int REFERENCES department ON DELETE CASCADE);
   CREATE TABLE employee(emp_id int PRIMARY KEY,designation_id int REFERENCES designation ON DELETE CASCADE);
   INSERT INTO department VALUES(54,'Professional'),(55,'Self Attendance');INSERT INTO designation VALUES(75,'Head',54),(78,'Head',55);INSERT INTO employee VALUES(42,75);`);
  await db.exec('BEGIN');await archiveShadowSchema(client,{schema:'cutover_shadow'});await renameSelfAttendance(client);await db.exec('COMMIT');
  assert.deepEqual((await db.query('SELECT * FROM employee')).rows,[{emp_id:42,designation_id:75}]);
  assert.equal((await db.query('SELECT designation_id FROM designation')).rows[0].designation_id,75);
  assert.equal((await db.query('SELECT designation_id FROM cutover_shadow.designation_shadow')).rows[0].designation_id,78);
 }finally{await db.close();}
});
test('archive refuses to operate outside an explicit transaction',async()=>{
 const {db,client}=await fixture();try{
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),/transaction/i);
  assert.equal((await db.query("SELECT to_regnamespace('cutover_shadow') AS n")).rows[0].n,null);
 }finally{await db.close();}
});
test('one-shot CLI rolls shadow archival back when a later Ward phase fails',async()=>{
 const fs=require('fs'),os=require('os'),path=require('path');
 const {main}=require('../scripts/retire-sector-memberships');
 const {db,client}=await fixture();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-cutover-'));
 try{
  await permissionFixture(db);const envFile=path.join(dir,'fixture.env');
  fs.writeFileSync(envFile,'DB_HOST=fixture\nDB_NAME=postgres\nDB_USER=fixture\nDB_PASSWORD=fake-fixture-password\n');
  class ClientType{async connect(){}async end(){}query(sql,params){return client.query(sql,params);}}
  await assert.rejects(main(['--env-file='+envFile,'--expected-host=fixture','--expected-database=postgres','--include-self-attendance-rename','--archive-unused-canonical'],{ClientType,reportDirectory:dir,log:()=>{}}),/wards/i);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance')).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM permissions')).rows[0].n,2);
  assert.equal((await db.query("SELECT to_regnamespace('self_attendance_shadow_cutover') AS n")).rows[0].n,null);
  await assert.rejects(main(['--archive-unused-canonical']),/requires the naming/);
 }finally{await db.close();for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}
});
test('active triggers and views cannot be stranded on archived shadow functions',async()=>{
 const {db,client}=await fixture();try{
  await db.exec(`CREATE FUNCTION professional_capture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;
   CREATE FUNCTION self_attendance_capture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$;
   CREATE TABLE unrelated(id int);
   CREATE TRIGGER active_capture BEFORE INSERT ON unrelated FOR EACH ROW EXECUTE FUNCTION self_attendance_capture();
   CREATE FUNCTION active_paid_day() RETURNS boolean LANGUAGE sql RETURN self_attendance_is_paid_day('11111111-1111-4111-8111-111111111111'::uuid,'2026-11-17'::date);
   CREATE VIEW active_function_report AS SELECT self_attendance_is_paid_day('11111111-1111-4111-8111-111111111111'::uuid,'2026-11-17'::date) AS paid;`);
  await db.exec('BEGIN');const plan=await inspectShadowSchema(client);
  assert.ok(plan.issues.some(i=>i.type==='external_shadow_function_trigger'));
  assert.ok(plan.issues.some(i=>i.type==='external_shadow_function_view'));
  assert.ok(plan.issues.some(i=>i.type==='external_shadow_function_caller'));
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),/requires reconciliation/);await db.exec('ROLLBACK');
 }finally{await db.close();}
});
test('a non-FK permission reference also blocks removal of a supposedly unused permission',async()=>{
 const {db,client}=await fixture();try{
  await permissionFixture(db);await db.exec('CREATE TABLE legacy_grants(permission_id int);INSERT INTO legacy_grants VALUES(20)');await db.exec('BEGIN');
  const plan=await inspectShadowSchema(client);assert.ok(plan.issues.some(i=>i.type==='assigned_shadow_permission'&&i.reference==='legacy_grants'));
  await assert.rejects(archiveShadowSchema(client,{schema:'cutover_shadow'}),/requires reconciliation/);await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM legacy_grants')).rows[0].n,1);
 }finally{await db.close();}
});
