const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {attendanceMergePlan,consolidateAttendance}=require('../utils/workforceAttendanceMerge');

test('deterministic attendance matrix preserves the union for 1–5 profiles and any chosen main',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE professional_attendance(id SERIAL PRIMARY KEY,professional_id UUID,date DATE,punch_in TIMESTAMP,punch_out TIMESTAMP,UNIQUE(professional_id,date))`);
  let seed=4187;
  const random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  for(let trial=0;trial<30;trial++){
   await db.exec('TRUNCATE professional_attendance RESTART IDENTITY');
   const size=1+trial%5;
   const ids=Array.from({length:size},(_,i)=>`c0000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
   const expected=new Set();
   for(const id of ids)for(let day=1;day<=12;day++)if(random()>.5){
    const date=`2026-10-${String(day).padStart(2,'0')}`;expected.add(date);
    await db.query('INSERT INTO professional_attendance(professional_id,date,punch_in,punch_out) VALUES($1,$2,$3,$4)',[id,date,`${date} 09:00`,`${date} 18:00`]);
   }
   const main=ids[trial%size];
   const plan=await attendanceMergePlan(db,ids,main);
   assert.equal(plan.summary.uniqueDays,expected.size,`trial ${trial}: preview union`);
   await consolidateAttendance(db,plan);
   await db.query('UPDATE professional_attendance SET professional_id=$1 WHERE professional_id=ANY($2::uuid[])',[main,ids]);
   const result=(await db.query('SELECT date::text AS date,professional_id FROM professional_attendance ORDER BY date')).rows;
   assert.deepEqual(result.map(row=>row.date),[...expected].sort(),`trial ${trial}: exact dates`);
   assert.ok(result.every(row=>row.professional_id===main));
  }
  console.log('PASS: 30 seeded profile/date combinations; exact unique dates and selected main ownership.');
 }finally{await db.close();}
});
