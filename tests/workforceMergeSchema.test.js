const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {refreshMergeTriggers}=require('../utils/workforceMergeSchema');
test('new reviewer dependencies receive redirects and recovery after an existing workforce deployment',async()=>{
 const db=new PGlite();
 const client={query:(sql,params)=>params?db.query(sql,params):db.exec(sql).then(results=>results.at(-1))};
 try{
  assert.equal(await refreshMergeTriggers(client),false);
  await db.exec(`CREATE TABLE employee(emp_id INT PRIMARY KEY);
   CREATE TABLE self_attendance_employees(id UUID PRIMARY KEY);
   CREATE TABLE workforce_review_issues(id INT PRIMARY KEY);
   CREATE TABLE attendance(id INT PRIMARY KEY,emp_id INT REFERENCES employee);
   CREATE TABLE self_attendance_records(id INT PRIMARY KEY,self_attendance_id UUID REFERENCES self_attendance_employees);`);
  for(const file of ['20261021_workforce_merge.sql','20261022_workforce_merge_recovery.sql'])
   await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));
  await refreshMergeTriggers(client);
  await db.exec(`CREATE TABLE register_attendance_requests(id INT PRIMARY KEY,requested_by UUID REFERENCES self_attendance_employees);
   ALTER TABLE attendance ADD COLUMN supervisor_in_by UUID REFERENCES self_attendance_employees;`);
  const {references,assertAliasTriggers}=require('../utils/workforceMerge');
  const plan={kind:'self_attendance',links:await references(client,'self_attendance')};
  await assert.rejects(assertAliasTriggers(client,plan),error=>error.status===503);
  await refreshMergeTriggers(client);
  await assertAliasTriggers(client,plan);
  const count=async()=>(await db.query("SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal")).rows[0].n;
  const before=await count();await refreshMergeTriggers(client);assert.equal(await count(),before);
  const old='11111111-1111-4111-8111-111111111111',main='22222222-2222-4222-8222-222222222222';
  await db.query('INSERT INTO self_attendance_employees VALUES($1)',[main]);
  await db.query("INSERT INTO workforce_employee_aliases(employee_kind,source_id,target_id) VALUES('self_attendance',$1,$2)",[old,main]);
  await db.exec(`INSERT INTO workforce_merge_audit(id,employee_kind,target_id,source_ids,actor_user_id,reason,profile_snapshots,affected_rows)
   VALUES(1,'self_attendance','${main}','{}',1,'fixture','[]','[]');
   SELECT set_config('matrixtrack.merge_id','1',false);`);
  await db.query('INSERT INTO register_attendance_requests VALUES(1,$1)',[old]);
  assert.equal((await db.query('SELECT requested_by FROM register_attendance_requests')).rows[0].requested_by,main);
  const journal=(await db.query("SELECT after_row FROM workforce_merge_changes WHERE table_name='register_attendance_requests'")).rows;
  assert.equal(journal.length,1);assert.equal(journal[0].after_row.requested_by,main);
  await db.exec('ALTER TABLE register_attendance_requests DISABLE TRIGGER workforce_capture_merge_change');
  await assert.rejects(refreshMergeTriggers(client),/requires review/);
 }finally{await db.close();}
});
