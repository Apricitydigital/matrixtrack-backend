'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {renameSelfAttendance}=require('../utils/selfAttendanceRenameMigration');
const {contractValue,loadLegacyEnvironment}=require('../utils/selfAttendanceNaming');
const compatibility=require('../middleware/selfAttendanceCompatibility');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),jwt=require('jsonwebtoken');
const person='a0000000-0000-4000-8000-000000000001';
const retired='a0000000-0000-4000-8000-000000000002';
async function fixture(){
  const db=new PGlite();
  await db.exec(`
    CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,status TEXT);
    INSERT INTO attendance VALUES(1,7,'2026-10-30T03:30:00Z',NULL,'present');
    CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);
    CREATE TABLE designation(designation_id INT PRIMARY KEY,department_id INT REFERENCES department,designation_name TEXT);
    INSERT INTO department VALUES(9,'Professional');INSERT INTO designation VALUES(10,9,'Professional');
    CREATE TABLE users(user_id INT PRIMARY KEY,permissions JSONB);
    INSERT INTO users VALUES(1,'{"modules":{"professional_attendance":"write","professional_weekly_off":"view"},"email":"professional@example.test"}');
    CREATE TABLE permissions(id SERIAL PRIMARY KEY,module TEXT,label TEXT,updated_at TIMESTAMPTZ DEFAULT '2026-01-01T00:00:00Z');
    INSERT INTO permissions(module,label) VALUES('professional-attendance','View Professional Attendance');
    CREATE FUNCTION set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$BEGIN NEW.updated_at:=now();RETURN NEW;END $$;
    CREATE TRIGGER permissions_updated_at BEFORE UPDATE ON permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TABLE city_daily_traffic_cost(id SERIAL PRIMARY KEY,source TEXT CHECK(source IN ('professional_punch_in','face_enrollment')),attendance_count INT);
    INSERT INTO city_daily_traffic_cost(source,attendance_count) VALUES('professional_punch_in',7);
    CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,password_hash TEXT,selfie_url TEXT,ward_id INT,kothi_id INT,is_active BOOLEAN);
    INSERT INTO professional_employees VALUES('${person}','Professional','password-with-professional','professional/selfies/original.jpg',100,10,true);
    CREATE TABLE professional_attendance(id UUID PRIMARY KEY,professional_id UUID REFERENCES professional_employees,
      date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,punch_in_photo_url TEXT,UNIQUE(professional_id,date));
    INSERT INTO professional_attendance VALUES('b0000000-0000-4000-8000-000000000001','${person}','2026-10-30','2026-10-30T09:00:00+05:30',NULL,'professional-attendance/original.jpg');
    CREATE TABLE professional_week_off_versions(id BIGSERIAL PRIMARY KEY,professional_id UUID REFERENCES professional_employees,week_off_days INT[],effective_from DATE);
    INSERT INTO professional_week_off_versions(professional_id,week_off_days,effective_from) VALUES('${person}',ARRAY[0],'2026-01-01');
    CREATE FUNCTION professional_week_off_days_at(person UUID,on_date DATE) RETURNS INT[] LANGUAGE SQL STABLE AS
      'SELECT week_off_days FROM professional_week_off_versions WHERE professional_id=person AND effective_from<=on_date ORDER BY effective_from DESC,id DESC LIMIT 1';
    CREATE FUNCTION professional_is_week_off(person UUID,on_date DATE) RETURNS BOOLEAN LANGUAGE SQL STABLE AS
      'SELECT EXTRACT(DOW FROM on_date)::int=ANY(professional_week_off_days_at(person,on_date))';
    CREATE VIEW professional_history AS SELECT id,professional_id,punch_in FROM professional_attendance;
    CREATE TABLE workforce_employee_aliases(employee_kind TEXT CHECK(employee_kind IN ('regular','professional')),source_id TEXT,target_id TEXT,PRIMARY KEY(employee_kind,source_id));
    INSERT INTO workforce_employee_aliases VALUES('professional','${retired}','${person}');
    CREATE FUNCTION workforce_redirect_employee_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE destination text;BEGIN SELECT target_id INTO destination FROM workforce_employee_aliases WHERE employee_kind=TG_ARGV[0] AND source_id=to_jsonb(NEW)->>TG_ARGV[1];
      IF destination IS NOT NULL THEN NEW:=jsonb_populate_record(NEW,jsonb_build_object(TG_ARGV[1],destination));END IF;RETURN NEW;END $$;
    CREATE TRIGGER workforce_alias_old BEFORE INSERT OR UPDATE OF professional_id ON professional_attendance
      FOR EACH ROW EXECUTE FUNCTION workforce_redirect_employee_reference('professional','professional_id');
    CREATE TABLE professional_leave_request_logs(id SERIAL PRIMARY KEY,actor_type VARCHAR(16) CHECK(actor_type IN ('professional','admin')),old_values JSONB);
    INSERT INTO professional_leave_request_logs(actor_type,old_values) VALUES('professional','{"professional_id":"${person}","selfie_url":"professional/original.jpg"}');
    CREATE TABLE workforce_merge_audit(id INT PRIMARY KEY,employee_kind TEXT,profile_snapshots JSONB,affected_rows JSONB,attendance_snapshots JSONB);
    INSERT INTO workforce_merge_audit VALUES(1,'professional','[{"id":"${person}","selfie_url":"professional/original.jpg"}]','[{"table":"professional_attendance","column":"professional_id"}]','[{"professional_id":"${person}"}]');
    CREATE TABLE workforce_merge_changes(id INT PRIMARY KEY,table_name TEXT,key_columns TEXT[],before_row JSONB,after_row JSONB);
    INSERT INTO workforce_merge_changes VALUES(1,'professional_attendance',ARRAY['id','professional_id'],'{"professional_id":"${retired}","punch_in_photo_url":"professional/original.jpg"}','{"professional_id":"${person}","punch_in_photo_url":"professional/original.jpg"}');
  `);
  return db;
}
const adapter=db=>({query:async(sql,params=[])=>params.length?db.query(sql,params):(await db.exec(sql)).at(-1)||{rows:[]}});
test('rename preserves IDs, credentials, punches, photos, permissions, week offs and recovery journal; reruns are safe',async()=>{
  const db=await fixture(),client=adapter(db);
  try {
    const original=(await db.query("SELECT oid FROM pg_class WHERE relname='professional_attendance'")).rows[0].oid;
    await db.exec('BEGIN');
    const result=await renameSelfAttendance(client);assert.equal(result.alreadyApplied,false);
    assert.equal(result.untouchedAttendance[0].table,'attendance');
    assert.deepEqual(result.untouchedAttendance[0].before,result.untouchedAttendance[0].after);
    await db.exec('COMMIT');
    assert.equal((await db.query("SELECT oid FROM pg_class WHERE relname='self_attendance_records'")).rows[0].oid,original);
    const employee=(await db.query('SELECT * FROM self_attendance_employees')).rows[0];
    assert.equal(employee.id,person);assert.equal(employee.full_name,'Professional');
    assert.equal(employee.password_hash,'password-with-professional');assert.equal(employee.selfie_url,'professional/selfies/original.jpg');
    const attendance=(await db.query('SELECT * FROM self_attendance_records')).rows[0];
    assert.equal(attendance.self_attendance_id,person);assert.equal(attendance.punch_out,null);
    assert.equal(attendance.punch_in_photo_url,'professional-attendance/original.jpg');
    assert.equal((await db.query('SELECT department_name FROM department')).rows[0].department_name,'Self Attendance');
    assert.equal((await db.query('SELECT designation_name FROM designation')).rows[0].designation_name,'Self Attendance');
    assert.equal((await db.query('SELECT module FROM permissions')).rows[0].module,'self-attendance-records');
    const permission=(await db.query('SELECT label,updated_at FROM permissions')).rows[0];
    assert.equal(permission.label,'View Self Attendance');assert.equal(new Date(permission.updated_at).toISOString(),'2026-01-01T00:00:00.000Z');
    assert.equal((await db.query("SELECT tgenabled FROM pg_trigger WHERE tgname='permissions_updated_at'")).rows[0].tgenabled,'O');
    assert.deepEqual((await db.query('SELECT source,attendance_count FROM city_daily_traffic_cost')).rows[0],{source:'self_attendance_punch_in',attendance_count:7});
    const permissions=(await db.query('SELECT permissions FROM users')).rows[0].permissions;
    assert.equal(permissions.modules.self_attendance_records,'write');assert.equal(permissions.email,'professional@example.test');
    assert.equal((await db.query("SELECT self_attendance_is_week_off($1,'2026-11-01') AS day",[person])).rows[0].day,true);
    const changes=(await db.query('SELECT * FROM workforce_merge_changes')).rows[0];
    assert.equal(changes.table_name,'self_attendance_records');assert.deepEqual(changes.key_columns,['id','self_attendance_id']);
    assert.equal(changes.before_row.self_attendance_id,retired);assert.equal(changes.before_row.punch_in_photo_url,'professional/original.jpg');
    // A delayed write under a merged old ID still redirects, using rewritten trigger arguments.
    await db.query("INSERT INTO self_attendance_records(id,self_attendance_id,date) VALUES('b0000000-0000-4000-8000-000000000002',$1,'2026-10-31')",[retired]);
    assert.equal((await db.query("SELECT self_attendance_id FROM self_attendance_records WHERE date='2026-10-31'")).rows[0].self_attendance_id,person);
    await db.exec('BEGIN');assert.equal((await renameSelfAttendance(client)).alreadyApplied,true);await db.exec('COMMIT');
  }finally{await db.close();}
});
test('full rehearsal rolls back the schema and all domain data',async()=>{
  const db=await fixture();
  try {
    await db.exec('BEGIN');await renameSelfAttendance(adapter(db));await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance')).rows[0].n,1);
    assert.equal((await db.query('SELECT department_name FROM department')).rows[0].department_name,'Professional');
    assert.equal((await db.query("SELECT to_regclass('self_attendance_employees') AS relation")).rows[0].relation,null);
  }finally{await db.close();}
});
test('mixed old and new schemas fail closed',async()=>{
  const db=await fixture();
  try {
    await db.exec('CREATE TABLE self_attendance_employees(id UUID);BEGIN');
    await assert.rejects(renameSelfAttendance(adapter(db)),/Target relation already exists/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_employees')).rows[0].n,1);
  }finally{await db.close();}
});

test('naming migration catches a regular employee punch change even with unchanged count and IDs',async()=>{
 const db=await fixture();try{
  const base=adapter(db);let injected=false;
  const client={query:async(sql,params)=>{
   const result=await base.query(sql,params);
   if(sql==='SET LOCAL check_function_bodies = on'){
    await db.exec("UPDATE attendance SET emp_id=8,punch_out='2026-10-30T13:00:00Z' WHERE attendance_id=1");injected=true;
   }
   return result;
  }};
  await db.exec('BEGIN');
  await assert.rejects(renameSelfAttendance(client),/Attendance preservation check failed: attendance/);
  assert.equal(injected,true);await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT emp_id,punch_out FROM attendance')).rows,[{emp_id:7,punch_out:null}]);
  assert.equal((await db.query("SELECT to_regclass('professional_attendance') IS NOT NULL AS original")).rows[0].original,true);
 }finally{await db.close();}
});

test('naming migration refuses unreviewed event triggers before any naming changes',async()=>{
 const db=await fixture();try{
  const base=adapter(db);await db.exec('BEGIN');
  await assert.rejects(renameSelfAttendance({query:(sql,params)=>sql.includes('FROM pg_event_trigger')?Promise.resolve({rows:[{evtname:'unreviewed'}]}):base.query(sql,params)}),/event triggers/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM professional_attendance')).rows[0].n,1);
 }finally{await db.close();}
});
test('legacy API aliases preserve old apps without rewriting names, image URLs or existing regular attendance fields',()=>{
  const req={url:'/api/professional/profile',query:{employeeType:'professional'},body:{professional_id:person,full_name:'Professional',selfie_url:'professional/original.jpg',self_attendance_enabled:true},get:()=>undefined};
  const res={json(body){this.body=body;return this;},status(){return this;}};
  let called=false;compatibility(req,res,()=>{called=true;});assert.equal(called,true);
  assert.equal(req.url,'/api/self-attendance/profile');assert.equal(req.body.self_attendance_id,person);assert.equal(req.query.employeeType,'self_attendance');
  assert.equal(req.body.full_name,'Professional');assert.equal(req.body.self_attendance_enabled,true);
  res.json({self_attendance:{self_attendance_id:person},employee_kind:'self_attendance',emp_id:'self_attendance:'+person,attendance_id:'self_attendance:record1',self_attendance_enabled:true,selfie_url:'professional/original.jpg'});
  assert.equal(res.body.professional.professional_id,person);assert.equal(res.body.employee_kind,'professional');
  assert.equal(res.body.emp_id,'professional:'+person);assert.equal(res.body.self_attendance_enabled,true);assert.equal(res.body.selfie_url,'professional/original.jpg');
  assert.equal(res.body.attendance_id,'professional:record1');
  for(const [oldPath,newPath] of [['/api/admin/professional-attendance/summary','/api/admin/self-attendance-records/summary'],
    ['/api/admin/workforce-review/professional/'+person+'/merge-preview','/api/admin/workforce-review/self_attendance/'+person+'/merge-preview']]) {
    const request={url:oldPath,query:{},get:()=>undefined};compatibility(request,{json(){},status(){return this;}},()=>{});assert.equal(request.url,newPath);
  }
  const canonicalReq={url:'/api/self-attendance/profile',query:{},get:()=>undefined};const canonicalRes={json(body){this.body=body;},status(){return this;}};
  compatibility(canonicalReq,canonicalRes,()=>{});canonicalRes.json({employee_kind:'self_attendance'});assert.equal(canonicalRes.body.employee_kind,'self_attendance');
  assert.throws(()=>contractValue({professional_id:person,self_attendance_id:retired}),/Conflicting/);
  const env={PROFESSIONAL_JWT_EXPIRES_IN:'45d',PROFESSIONAL_LIVENESS_ENABLED:'false',SELF_ATTENDANCE_JWT_EXPIRES_IN:'30d'};
  loadLegacyEnvironment(env);assert.equal(env.SELF_ATTENDANCE_JWT_EXPIRES_IN,'30d');assert.equal(env.SELF_ATTENDANCE_LIVENESS_ENABLED,'false');
});
test('pre-rename JWTs and canonical JWTs authenticate the same current account; conflicts and tampering fail closed',async()=>{
  const module={exports:{}};let active=true;
  const secret='offline-self-attendance-rename-fixture';
  const deps={jsonwebtoken:jwt,'../config/db':{query:async(sql,params)=>{assert.match(sql,/self_attendance_employees/);assert.equal(params[0],person);return {rows:[{city_id:1,zone_id:2,ward_id:100,kothi_id:10,is_active:active}]};}},
    '../utils/employeeAliases':{resolveEmployeeAlias:async(kind,id)=>{assert.equal(kind,'self_attendance');return id===retired?person:id;}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../middleware/selfAttendanceAuth.js'),'utf8'),{module,require:name=>deps[name],process:{env:{JWT_SECRET:secret}}});
  const call=async token=>{let called=false;const req={cookies:{},header:()=>`Bearer ${token}`};const res={status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await module.exports(req,res,()=>{called=true;});return {called,req,res};};
  for(const claims of [{professional_id:person},{professional_id:retired},{self_attendance_id:person}]){
    const result=await call(jwt.sign({...claims,city_id:999},secret));assert.equal(result.called,true);
    assert.equal(result.req.self_attendance.self_attendance_id,person);assert.equal(result.req.self_attendance.city_id,1);
  }
  assert.equal((await call(jwt.sign({professional_id:retired,self_attendance_id:person},secret))).res.code,403);
  assert.equal((await call(jwt.sign({professional_id:person},'wrong-secret'))).res.code,403);
  active=false;assert.equal((await call(jwt.sign({professional_id:person},secret))).res.code,403);
});
test('renamed attendance permissions retain their normalized admin-module mapping',async()=>{
  const module={exports:{}};
  const deps={'../config/db':{query:async()=>({rows:[{role:'admin',permissions:{role_type:'city_admin',modules:{self_attendance_records:'write'}}}]})},
    '../utils/userCityAccess':{fetchUserCityAccess:async()=>({all:true,ids:[]}),invalidateCityAccessCache(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../middleware/permissionMiddleware.js'),'utf8'),{module,require:name=>deps[name],Map,Set,console});
  let authorized=false;const res={status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
  await module.exports.authorize('self-attendance-records','view')({user:{user_id:1}},res,()=>{authorized=true;});assert.equal(authorized,true);
  assert.equal(contractValue({modules:{self_attendance_records:'write'}},'legacy').modules.professional_attendance,'write');
});
