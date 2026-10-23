const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');

test('00:00 skips a 20:00 punch; 07:00 catches it; eight-hour boundary, manual out and reruns are safe',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE employee(emp_id INT PRIMARY KEY,name TEXT,emp_code TEXT);
   CREATE TABLE professional_employees(id INT PRIMARY KEY,full_name TEXT,emp_code TEXT);
   CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,date DATE,punch_in_time TIMESTAMP,punch_out_time TIMESTAMP,duration TEXT,auto_punched_out BOOLEAN DEFAULT false,out_address TEXT,updated_at TIMESTAMPTZ);
   CREATE TABLE professional_attendance(id INT PRIMARY KEY,professional_id INT,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,auto_punched_out BOOLEAN DEFAULT false,out_address TEXT);
   INSERT INTO employee SELECT n,'Employee','E'||n FROM generate_series(1,5) n;
   INSERT INTO professional_employees SELECT n,'Professional','P'||n FROM generate_series(1,5) n;
   BEGIN;
   INSERT INTO attendance(attendance_id,emp_id,date,punch_in_time,punch_out_time)
   SELECT n,n,(NOW() AT TIME ZONE 'Asia/Kolkata')::date-1,
    (NOW() AT TIME ZONE 'Asia/Kolkata')-CASE WHEN n=1 THEN INTERVAL '4 hours' WHEN n=2 THEN INTERVAL '8 hours' WHEN n=3 THEN INTERVAL '7 hours 59 minutes 59 seconds' ELSE INTERVAL '11 hours' END,
    CASE WHEN n=5 THEN (NOW() AT TIME ZONE 'Asia/Kolkata')-INTERVAL '1 hour' ELSE NULL END
   FROM generate_series(1,5) n;
   INSERT INTO professional_attendance(id,professional_id,date,punch_in,punch_out)
   SELECT attendance_id,emp_id,date,punch_in_time AT TIME ZONE 'Asia/Kolkata',punch_out_time AT TIME ZONE 'Asia/Kolkata' FROM attendance;`);
  const pool={connect:async()=>({query:(sql,params)=>db.query(sql,params),release(){}})};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/autoPunchOutScheduler.js'),'utf8'),{module,require:()=>pool,process:{env:{AUTO_PUNCHOUT_HOURS:'8'}},console:{log(){},error(){}},Date});
  const first=await module.exports.runAutoPunchOut();
  assert.equal(first.regularProcessed,2);assert.equal(first.professionalProcessed,2);
  for(const [table,key,out] of [['attendance','attendance_id','punch_out_time'],['professional_attendance','id','punch_out']]){
   const rows=(await db.query(`SELECT ${key} AS id,auto_punched_out,${out} AS out FROM ${table} ORDER BY ${key}`)).rows;
   assert.deepEqual(rows.filter(row=>row.auto_punched_out).map(row=>row.id),[2,4]);
   assert.equal(rows[0].out,null,'Four-hour shift must remain open');
   assert.equal(rows[2].out,null,'One second short of eight hours stays open');
   assert.equal(rows[4].auto_punched_out,false,'Manual punch-out stays manual');
  }
  assert.equal((await module.exports.runAutoPunchOut()).processed,0);
  // Same open shift reaches eleven hours at the morning run.
  await db.exec(`UPDATE attendance SET punch_in_time=punch_in_time-INTERVAL '7 hours' WHERE attendance_id=1;
   UPDATE professional_attendance SET punch_in=punch_in-INTERVAL '7 hours' WHERE id=1;`);
  const morning=await module.exports.runAutoPunchOut();
  assert.equal(morning.regularProcessed,1);assert.equal(morning.professionalProcessed,1);
  await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('schedule runs at 00:00 and 07:00 IST without repeat timers',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
 const section=source.slice(source.indexOf('const AUTO_PUNCHOUT_CRON_ENABLED'),source.indexOf('// General API Route'));
 assert.ok(section.includes('"0 0,7 * * *"'));
 assert.ok(section.includes('timezone: "Asia/Kolkata"'));
 assert.ok(!section.includes('setInterval'));
});
