// Uses isolated PostgreSQL with a fixed clock; never sends real push/SMS.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {PGlite}=require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
(async()=>{
 const db=new PGlite();const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
 let now='2026-10-16T03:59:00Z',locked=true,unlocks=0,releases=0,pushes=[],templates=[];
 const client={release(){releases++;},async query(sql,params){
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked}]};
  if(sql.includes('pg_advisory_unlock')){unlocks++;return {rows:[]};}
  templates=JSON.parse(params[0]);
  const deterministicRandom="((substring(pe.id::text from 25)::numeric % 16)/16.0)";
  return db.query(sql.replaceAll('NOW()',"TIMESTAMPTZ '"+now+"'").replaceAll('random()',deterministicRandom),params);
 }};
 try{
  await db.exec(`CREATE TABLE professional_employees(id UUID PRIMARY KEY,is_active BOOLEAN DEFAULT TRUE,reminder_enabled BOOLEAN DEFAULT TRUE,city_id INT DEFAULT 1,zone_id INT DEFAULT 1,ward_id INT DEFAULT 1,kothi_id INT DEFAULT 1);
   CREATE TABLE professional_punch_cutoffs(professional_id UUID PRIMARY KEY,cutoff_time TIME);
   CREATE TABLE professional_attendance(professional_id UUID,date DATE);
   CREATE TABLE professional_leave_requests(professional_id UUID,requested_date DATE,status TEXT);
   CREATE TABLE professional_holidays(holiday_date DATE,city_id INT,zone_id INT,ward_id INT,kothi_id INT);
   CREATE TABLE professional_notifications(id UUID DEFAULT gen_random_uuid(),professional_id UUID,type TEXT,title TEXT,message TEXT,metadata JSONB);
   CREATE FUNCTION professional_is_week_off(UUID,DATE) RETURNS BOOLEAN LANGUAGE SQL AS $$ SELECT $1='00000000-0000-4000-8000-000000000007'::uuid $$;`);
  for(let n=1;n<=10;n++){await db.query('INSERT INTO professional_employees(id) VALUES($1)',[id(n)]);if(n!==3)await db.query('INSERT INTO professional_punch_cutoffs VALUES($1,$2)',[id(n),n===2?'11:00':'09:30']);}
  await db.query('UPDATE professional_employees SET is_active=FALSE WHERE id=$1',[id(4)]);
  await db.query('INSERT INTO professional_attendance VALUES($1,$2)',[id(5),'2026-10-16']);
  await db.query('INSERT INTO professional_leave_requests VALUES($1,$2,$3)',[id(6),'2026-10-16','approved']);
  await db.query('UPDATE professional_employees SET kothi_id=2 WHERE id=$1',[id(8)]);
  await db.query("INSERT INTO professional_holidays VALUES('2026-10-16',1,NULL,NULL,2)");
  await db.query('UPDATE professional_employees SET reminder_enabled=FALSE WHERE id=$1',[id(9)]);
  await db.query("INSERT INTO professional_leave_requests VALUES($1,'2026-10-16','pending')",[id(10)]);
  const module={exports:{}};const deps={'../config/db':{connect:async()=>client},'./professionalLeaveSchema':{ensureProfessionalLeaveSchema:async options=>assert.equal(options.expirePending,false)},'./professionalPunchCutoff':{ensurePunchCutoffSchema:async()=>{}},'./professionalPushService':{sendPushToProfessionals:async rows=>{pushes.push(...rows);return {sent:rows.length};}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/professionalPunchInReminder.js'),'utf8'),{require:name=>{if(!(name in deps))throw Error(name);return deps[name];},module,process:{env:{PROFESSIONAL_REMINDER_BATCH_SIZE:'50'}},console});
  const run=module.exports.runProfessionalPunchInReminder;
  assert.equal((await run()).sentCount,0,'09:29 IST is before the assigned time');
  now='2026-10-16T04:00:00Z';assert.equal((await run()).sentCount,2,'09:30 IST sends immediately, not at 09:45');
  assert.deepEqual(pushes.map(row=>row.professional_id).sort(),[id(1),id(10)]);
  for(const row of pushes){assert.equal(row.metadata.reminder_time,'09:30');assert.ok(templates.some(item=>item.title===row.title&&item.message===row.message));}
  assert.notEqual(pushes[0].title,pushes[1].title,'Message choice is evaluated separately for each employee');
  assert.equal((await run()).sentCount,0,'Repeated cron ticks do not duplicate reminders');
  now='2026-10-16T04:45:00Z';assert.equal((await run()).sentCount,1,'Unassigned employees retain the 10:00 default');assert.equal(pushes.at(-1).professional_id,id(3));
  assert.equal((await run()).sentCount,0);
  now='2026-10-16T05:30:00Z';assert.equal((await run()).sentCount,1,'11:00 assigned time is independent of the old 10:00 window');assert.equal(pushes.at(-1).professional_id,id(2));
  for(let n=20;n<85;n++){await db.query('INSERT INTO professional_employees(id) VALUES($1)',[id(n)]);await db.query("INSERT INTO professional_punch_cutoffs VALUES($1,'12:00')",[id(n)]);}
  now='2026-10-16T06:37:00Z';const recovery=await run();assert.equal(recovery.sentCount,65,'12:07 catches a brief restart');assert.equal(recovery.batchCount,2,'All batches are drained');
  await db.query('INSERT INTO professional_employees(id) VALUES($1)',[id(90)]);await db.query("INSERT INTO professional_punch_cutoffs VALUES($1,'12:00')",[id(90)]);
  now='2026-10-16T06:46:00Z';assert.equal((await run()).sentCount,0,'Stale reminders outside recovery window are skipped');
  locked=false;const oldUnlocks=unlocks;assert.equal((await run()).skipped,true);assert.equal(unlocks,oldUnlocks,'A worker never unlocks another worker lock');assert.ok(releases>0);
  locked=true;now='2026-10-17T04:00:00Z';assert.ok((await run()).sentCount>0,'Daily dedup resets on the next IST date');
  console.log('PASS: assigned IST times, no grace delay, per-employee message pairs, fallback, dedup, leave/week-off/holiday/inactive/opt-out skips, batching, recovery and lock handling.');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
