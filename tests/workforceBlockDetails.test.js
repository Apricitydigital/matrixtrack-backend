const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {workforceBlockDetails}=require('../utils/workforceBlockDetails');

test('workforce block badges use current access and exact block date without changing history or confusing inactive and blocked',async()=>{
 const db=new PGlite();
 const blocked='11111111-1111-4111-8111-111111111111',inactive='22222222-2222-4222-8222-222222222222';
 const profiles=[{kind:'self_attendance',id:blocked,active:'true',status:'present',present_days:92},{kind:'self_attendance',id:inactive,active:'false',status:'present',present_days:4},{kind:'regular',id:'10',emp_code:'SAME',status:'present'}];
 try{
  let rows=await workforceBlockDetails(db,profiles);
  assert.ok(rows.every(row=>row.is_attendance_blocked===false),'optional schema does not block the directory');
  await db.exec(`CREATE TABLE self_attendance_records_blocks(self_attendance_id UUID PRIMARY KEY,is_blocked BOOLEAN,reason TEXT,updated_at TIMESTAMPTZ);
   INSERT INTO self_attendance_records_blocks VALUES('${blocked}',true,'Access under review','2026-11-26T05:00:00Z'),('${inactive}',false,'Unblocked','2026-11-25T05:00:00Z');`);
  rows=await workforceBlockDetails(db,profiles);
  assert.equal(rows.length,3);assert.equal(rows[0].is_attendance_blocked,true);assert.equal(new Date(rows[0].attendance_blocked_at).toISOString(),'2026-11-26T05:00:00.000Z');
  assert.equal(rows[0].attendance_block_reason,'Access under review');assert.equal(rows[0].status,'present');assert.equal(rows[0].present_days,92);
  assert.equal(rows[1].is_attendance_blocked,false,'inactive is not a punch-access block');assert.equal(rows[2].is_attendance_blocked,false,'different regular account is not blocked by a self account');
  await db.query('UPDATE self_attendance_records_blocks SET is_blocked=false WHERE self_attendance_id=$1',[blocked]);
  const unblocked=await workforceBlockDetails(db,rows);
  assert.equal(unblocked[0].is_attendance_blocked,false);assert.equal(unblocked[0].attendance_blocked_at,null);assert.equal(unblocked[0].present_days,92);
  await db.query("UPDATE self_attendance_records_blocks SET is_blocked=true,updated_at='2026-11-26T09:00:00Z' WHERE self_attendance_id=$1",[blocked]);
  assert.equal(new Date((await workforceBlockDetails(db,profiles))[0].attendance_blocked_at).toISOString(),'2026-11-26T09:00:00.000Z','reblocking shows the new block date');
 }finally{await db.close();}
});
