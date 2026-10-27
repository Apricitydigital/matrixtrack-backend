const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite');
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const response=()=>({code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
test('reminder settings persist opt-out, expose the actual assigned IST time, and never alter attendance or cutoffs',async()=>{
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE professional_employees(id UUID PRIMARY KEY,reminder_enabled BOOLEAN,reminder_time TEXT,full_name TEXT);
   CREATE TABLE professional_punch_cutoffs(professional_id UUID PRIMARY KEY,cutoff_time TIME);
   CREATE TABLE professional_attendance(id INT,professional_id UUID,punch_in TIMESTAMPTZ);`);
  await db.query("INSERT INTO professional_employees VALUES($1,FALSE,'08:00','First'),($2,TRUE,'07:00','Second')",[id,other]);
  await db.query("INSERT INTO professional_punch_cutoffs VALUES($1,'09:30')",[id]);
  await db.query("INSERT INTO professional_attendance VALUES(1,$1,'2026-10-26T04:00:00Z')",[id]);
  const module={exports:{}};vm.runInNewContext(fs.readFileSync('controllers/professionalReminderSettingsController.js','utf8'),{module,require:()=>db});
  const api=module.exports;
  const call=async(action,body={},account=id)=>{const res=response();await api[action]({professional:{professional_id:account},body},res);return res;};
  const before=await db.query('SELECT * FROM professional_attendance');
  let res=await call('getReminderSettings');assert.equal(res.body.data.reminder_enabled,false);assert.equal(res.body.data.reminder_time,'09:30');
  res=await call('getReminderSettings',{},other);assert.equal(res.body.data.reminder_time,'10:00');
  res=await call('saveReminderSettings',{reminder_enabled:true,reminder_time:'06:00',professional_id:other});assert.equal(res.code,200);assert.equal(res.body.data.reminder_enabled,true);assert.equal(res.body.data.reminder_time,'09:30');
  await call('saveReminderSettings',{reminder_enabled:false});assert.equal((await call('getReminderSettings')).body.data.reminder_enabled,false);
  assert.equal((await call('getReminderSettings',{},other)).body.data.reminder_enabled,true);
  for(const value of [undefined,'false',1,null])assert.equal((await call('saveReminderSettings',{reminder_enabled:value})).code,400);
  assert.equal((await call('getReminderSettings',{},'00000000-0000-4000-8000-000000000003')).code,404);
  assert.deepEqual(await db.query('SELECT * FROM professional_attendance'),before);
  assert.equal((await db.query('SELECT cutoff_time::text FROM professional_punch_cutoffs')).rows[0].cutoff_time,'09:30:00');
  assert.equal((await db.query('SELECT reminder_time FROM professional_employees WHERE id=$1',[id])).rows[0].reminder_time,'08:00');
 }finally{await db.close();}
});
