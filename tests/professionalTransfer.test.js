const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {transferProfessional}=require('../utils/professionalTransfer');

test('transfer controller checks the current admin role and rolls back a rejected transfer',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const filename=path.join(__dirname,'../controllers/professionalTransferController.js');
 let user={role:'supervisor',is_deleted:false};const commands=[];
 const client={query:async sql=>{commands.push(sql);return {rows:[]};},release:()=>commands.push('RELEASE')};
 const module={exports:{}};
 vm.runInNewContext('(function(require,module){'+fs.readFileSync(filename,'utf8')+'})',{console})(name=>{
  if(name==='../config/db')return {query:async()=>({rows:user?[user]:[]}),connect:async()=>client};
  if(name==='../middleware/permissionMiddleware')return {getPermissionCityFilter:()=>[1]};
  if(name==='../utils/professionalTransfer')return {transferProfessional:async()=>{throw Object.assign(new Error('Access denied'),{status:403});}};
  throw new Error(name);
 },module);
 const {requireTransferAdmin,transferRequest}=module.exports;
 const response=()=>({code:200,status(code){this.code=code;return this;},json(data){this.data=data;return this;}});
 for(const candidate of [null,{role:'supervisor'},{role:'admin',is_deleted:true}]) {
  user=candidate;const res=response();let next=false;
  await requireTransferAdmin({supervisorId:9},res,()=>{next=true;});
  assert.equal(res.code,403);assert.equal(next,false);
 }
 user={role:'admin',is_deleted:false};let next=false;
 await requireTransferAdmin({supervisorId:9},response(),()=>{next=true;});assert.equal(next,true);
 const res=response();await transferRequest({params:{id:'10000000-0000-4000-8000-000000000001'},supervisorId:9,body:{}},res);
 assert.equal(res.code,403);assert.ok(commands.includes('ROLLBACK'));assert.ok(!commands.includes('COMMIT'));assert.equal(commands.at(-1),'RELEASE');
});

test('professional transfer preserves history and identity, validates scope and rolls back failures',async()=>{
 const db=new PGlite();
 const id='10000000-0000-4000-8000-000000000001';
 try {
  await db.exec(`CREATE TABLE cities(city_id INT PRIMARY KEY,city_name TEXT);
   CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT,zone_name TEXT);
   CREATE TABLE sectors(sector_id INT PRIMARY KEY,zone_id INT,sector_name TEXT);
   CREATE TABLE wards(ward_id INT PRIMARY KEY,sector_id INT,zone_id INT,ward_name TEXT);
   INSERT INTO cities VALUES(1,'Old city'),(2,'New city');
   INSERT INTO zones VALUES(10,1,'Old zone'),(20,2,'New zone');
   INSERT INTO sectors VALUES(100,10,'Old ward'),(200,20,'New ward');
   INSERT INTO wards VALUES(1000,100,10,'Old kothi'),(2000,200,20,'New kothi');
   CREATE TABLE self_punch_requests(id UUID PRIMARY KEY,status TEXT,emp_code TEXT,mobile TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,updated_at TIMESTAMPTZ,full_name TEXT,aadhar_number TEXT,selfie_url TEXT,aadhar_doc_url TEXT);
   INSERT INTO self_punch_requests VALUES('${id}','approved','P1','9876543210',1,10,100,1000,'2026-10-26 09:00+05:30','Professional','encrypted-aadhaar','selfie','document');
   CREATE TABLE professional_employees AS SELECT *, 'password-hash'::text AS password_hash FROM self_punch_requests;
   CREATE TABLE employee(emp_id INT PRIMARY KEY,emp_code TEXT,ward_id INT,name TEXT,face_embedding TEXT);
   INSERT INTO employee VALUES(7,'P1',1000,'Professional','enrolled-face'),(8,'OTHER',1000,'Other','other-face');
   CREATE TABLE professional_attendance(id INT PRIMARY KEY,professional_id UUID,date DATE,city_id INT,kothi_id INT,punch_in TIMESTAMPTZ,ward_id INT,zone_id INT,punch_out TIMESTAMPTZ);
   INSERT INTO professional_attendance VALUES(1,'${id}','2026-10-25',1,1000,'2026-10-25 09:00+05:30',100,10,NULL);
   CREATE TABLE professional_settings(professional_id UUID,week_off_days INT[],leave_count INT,geofence TEXT);
   INSERT INTO professional_settings VALUES('${id}',ARRAY[0],3,'old-geofence');
   CREATE TABLE self_punch_request_logs(id SERIAL PRIMARY KEY,request_id UUID,action TEXT,performed_by_type TEXT,performed_by_id INT,note TEXT);`);
  const snapshot=async table=>(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)->>'emp_id',to_jsonb(t)->>'id'`)).rows.map(r=>r.row);
  const before={};for(const table of ['self_punch_requests','professional_employees','employee','professional_attendance','professional_settings']) before[table]=await snapshot(table);
  const body={city_id:2,zone_id:20,ward_id:200,kothi_id:2000,reason:'Transfer to new site',updated_at:'2026-10-26T03:30:00Z',full_name:'MUST NOT CHANGE',password_hash:'MUST NOT CHANGE'};
  async function run(input=body,scope=null,client=db) {
   await db.query('BEGIN');
   try {const result=await transferProfessional(client,id,input,9,scope);await db.query('COMMIT');return result;}
   catch(e){await db.query('ROLLBACK');throw e;}
  }
  // Reproduce production's original foreign keys: valid destination sector
  // 200 is absent from wards, and destination kothi 2000 is absent from the
  // obsolete kothi_assignments table. Neither should block a modern transfer.
  await db.exec(`INSERT INTO wards VALUES(100,100,10,'Legacy ward');
   CREATE TABLE kothi_assignments(id INT PRIMARY KEY);
   INSERT INTO kothi_assignments VALUES(1000);
   ALTER TABLE self_punch_requests ADD CONSTRAINT self_punch_requests_ward_id_fkey FOREIGN KEY(ward_id) REFERENCES wards(ward_id);
   ALTER TABLE self_punch_requests ADD CONSTRAINT self_punch_requests_kothi_id_fkey FOREIGN KEY(kothi_id) REFERENCES kothi_assignments(id);
   ALTER TABLE professional_employees ADD CONSTRAINT professional_employees_ward_id_fkey FOREIGN KEY(ward_id) REFERENCES wards(ward_id);
   ALTER TABLE professional_employees ADD CONSTRAINT professional_employees_kothi_id_fkey FOREIGN KEY(kothi_id) REFERENCES kothi_assignments(id);
   ALTER TABLE professional_attendance ADD CONSTRAINT professional_attendance_ward_id_fkey FOREIGN KEY(ward_id) REFERENCES wards(ward_id);`);
  await assert.rejects(run(),{code:'23503'});
  const migration=require('node:fs').readFileSync(require('node:path').join(__dirname,'../db/migrations/20261029_professional_assignment_references.sql'),'utf8');
  // Include a legacy reference that cannot yet be validated against sectors.
  await db.exec(`INSERT INTO wards VALUES(999,100,10,'Historical ward');
   INSERT INTO self_punch_requests(id,status,ward_id) VALUES('10000000-0000-4000-8000-000000000002','pending',999);`);
  for(let i=0;i<2;i++)await db.exec(`BEGIN;${migration}COMMIT;`);
  assert.equal((await db.query("SELECT ward_id FROM self_punch_requests WHERE id='10000000-0000-4000-8000-000000000002'")).rows[0].ward_id,999);
  // New invalid keys remain rejected even though legacy rows are preserved.
  await assert.rejects(db.query("UPDATE self_punch_requests SET ward_id=998 WHERE id=$1",[id]),{code:'23503'});
  await assert.rejects(db.query("UPDATE professional_employees SET kothi_id=998 WHERE id=$1",[id]),{code:'23503'});
  await db.exec("DELETE FROM self_punch_requests WHERE id='10000000-0000-4000-8000-000000000002'");
  for(const [change,status] of [[{zone_id:10},400],[{kothi_id:1000},400],[{ward_id:''},400],[{reason:''},400],[{updated_at:'2026-10-25'},409]]) {
   await assert.rejects(run({...body,...change}),{status});
  }
  await assert.rejects(run(body,[1]),{status:403});
  await assert.rejects(run(body,[2]),{status:403});
  const failingClient={query:(sql,params)=>sql.includes('INSERT INTO self_punch_request_logs')?Promise.reject(new Error('audit unavailable')):db.query(sql,params)};
  await assert.rejects(run(body,null,failingClient),/audit unavailable/);
  for(const table of Object.keys(before))assert.deepEqual(await snapshot(table),before[table],`${table} unchanged after failed transfers`);
  const result=await run(body,[1,2]);assert.equal(result.kothi_name,'New kothi');
  for(const table of ['self_punch_requests','professional_employees']) {
   const after=(await snapshot(table))[0];
   for(const field of ['city_id','zone_id','ward_id','kothi_id'])assert.equal(after[field],body[field]);
   const strip=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['city_id','zone_id','ward_id','kothi_id',...(table==='self_punch_requests'?['updated_at']:[])].includes(key)));
   assert.deepEqual(strip(after),strip(before[table][0]));
  }
  const master=await snapshot('employee');assert.deepEqual(master,[{...before.employee[0],ward_id:2000},before.employee[1]]);
  for(const table of ['professional_attendance','professional_settings'])assert.deepEqual(await snapshot(table),before[table]);
  const logs=await snapshot('self_punch_request_logs');assert.equal(logs.length,1);assert.equal(logs[0].performed_by_id,9);assert.match(logs[0].note,/Old city.*New city.*Transfer to new site/);
  await assert.rejects(run(),{status:409});
  const fresh=(await snapshot('self_punch_requests'))[0];
  await assert.rejects(run({...body,updated_at:fresh.updated_at}),/different assignment/);

  // A transfer could succeed after the profile repair, then fail only when a
  // matching face reached attendance INSERT. Sector 200 is absent from wards.
  const punch=async(recordId,date)=>db.query(`INSERT INTO professional_attendance
    (id,professional_id,date,city_id,zone_id,ward_id,kothi_id,punch_in)
    SELECT $2,id,$3,city_id,zone_id,ward_id,kothi_id,NOW()
    FROM professional_employees WHERE id=$1 RETURNING *`,[id,recordId,date]);
  await assert.rejects(punch(2,'2026-10-26'),error=>error.code==='23503' && error.constraint==='professional_attendance_ward_id_fkey');
  const attendanceMigration=require('node:fs').readFileSync(require('node:path').join(__dirname,'../db/migrations/20261030_professional_attendance_references.sql'),'utf8');
  const historyBefore=await snapshot('professional_attendance');
  for(let i=0;i<2;i++)await db.exec(`BEGIN;${attendanceMigration}COMMIT;`);
  assert.deepEqual(await snapshot('professional_attendance'),historyBefore,'repeated deployment preserves all historical punches');
  const newPunch=(await punch(2,'2026-10-26')).rows[0];
  assert.equal(newPunch.ward_id,200);assert.equal(newPunch.kothi_id,2000);
  await db.query('UPDATE professional_attendance SET punch_out=NOW() WHERE id=2');

  // Existing legacy profiles may have ward IDs absent from sectors. They must
  // still punch; replacing the old FK with a sectors FK would break them.
  await db.query('ALTER TABLE professional_employees DROP CONSTRAINT professional_employees_ward_id_fkey');
  await db.query('UPDATE professional_employees SET ward_id=999 WHERE id=$1',[id]);
  await db.exec(`BEGIN;${migration}${attendanceMigration}COMMIT;`);
  const legacyPunch=(await punch(3,'2026-10-27')).rows[0];
  assert.equal(legacyPunch.ward_id,999);
  await db.query('UPDATE professional_attendance SET punch_out=NOW() WHERE id=3');
  const punchesBeforeNextTransfer=await snapshot('professional_attendance');
  await run({...body,city_id:1,zone_id:10,ward_id:100,kothi_id:1000,updated_at:fresh.updated_at});
  assert.deepEqual(await snapshot('professional_attendance'),punchesBeforeNextTransfer,'a later transfer preserves each earlier posting snapshot');
  const nextPunch=(await punch(4,'2026-10-28')).rows[0];
  assert.equal(nextPunch.ward_id,100);assert.equal(nextPunch.kothi_id,1000);
  assert.deepEqual((await snapshot('professional_attendance'))[0],historyBefore[0]);
  await assert.rejects(db.query('UPDATE professional_employees SET ward_id=998 WHERE id=$1',[id]),{code:'23503'});

  await db.query("UPDATE self_punch_requests SET status='pending' WHERE id=$1",[id]);
  const finalRequest=(await snapshot('self_punch_requests'))[0];
  await assert.rejects(run({...body,updated_at:finalRequest.updated_at}),{status:409});
 } finally {await db.close();}
});
