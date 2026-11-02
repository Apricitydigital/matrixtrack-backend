'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {fullRowFingerprint}=require('../utils/fullRowFingerprint');
const {retireSectorMemberships}=require('../utils/sectorRetirement');
const adapter=db=>({query:async(sql,params=[])=>params.length?db.query(sql,params):(await db.exec(sql)).at(-1)||{rows:[]}});

test('full attendance fingerprint detects reassignment and changed punch/status with identical row count and ID sum',async()=>{
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,status TEXT);
   INSERT INTO attendance VALUES(1,7,'2026-10-31T03:30:00Z',NULL,'present'),(2,8,'2026-10-31T04:30:00Z',NULL,'present'); BEGIN`);
  const client=adapter(db),before=await fullRowFingerprint(client,'attendance',{batchSize:1});
  const totals=()=>db.query('SELECT count(*)::text AS n,sum(attendance_id)::text AS s FROM attendance');
  const original=(await totals()).rows;
  for(const update of ["UPDATE attendance SET emp_id=99 WHERE attendance_id=1","UPDATE attendance SET punch_in=punch_in+INTERVAL '1 hour' WHERE attendance_id=1","UPDATE attendance SET status='absent' WHERE attendance_id=1","UPDATE attendance SET punch_out='2026-10-31T13:00:00Z' WHERE attendance_id=1"]){
   await db.exec('SAVEPOINT corruption');await db.exec(update);
   assert.deepEqual((await totals()).rows,original);
   assert.notEqual((await fullRowFingerprint(client,'attendance',{batchSize:1})).row_sha256,before.row_sha256);
   await db.exec('ROLLBACK TO corruption');
  }
  assert.deepEqual(await fullRowFingerprint(client,'attendance'),before);
  await db.exec('ROLLBACK');
 }finally{await db.close();}
});

test('full-row digest preserves duplicate multiplicity, empty histories and batch/physical insertion order independence',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE a(v TEXT);CREATE TABLE b(v TEXT);BEGIN');const client=adapter(db);
  const empty=await fullRowFingerprint(client,'a');assert.equal(empty.count,'0');
  await db.exec("INSERT INTO a VALUES('x'),('y'),('x');INSERT INTO b VALUES('y'),('x'),('x')");
  assert.deepEqual(await fullRowFingerprint(client,'a',{batchSize:1}),await fullRowFingerprint(client,'b',{batchSize:2}));
  await db.exec("DELETE FROM b WHERE ctid=(SELECT ctid FROM b WHERE v='x' LIMIT 1)");
  assert.notEqual((await fullRowFingerprint(client,'a')).row_sha256,(await fullRowFingerprint(client,'b')).row_sha256);
  await db.exec('ROLLBACK');
 }finally{await db.close();}
});

async function fixture(){const db=new PGlite();await db.exec(`
 CREATE TABLE cities(city_id INT PRIMARY KEY);INSERT INTO cities VALUES(1);
 CREATE TABLE zones(zone_id INT PRIMARY KEY,city_id INT);INSERT INTO zones VALUES(10,1);
 CREATE TABLE sectors(sector_id INT PRIMARY KEY,zone_id INT);INSERT INTO sectors VALUES(100,10);
 CREATE TABLE wards(ward_id INT PRIMARY KEY,ward_name TEXT,zone_id INT,sector_id INT);INSERT INTO wards VALUES(1001,'Ward',10,100);
 CREATE TABLE employee(emp_id INT PRIMARY KEY,ward_id INT);INSERT INTO employee VALUES(7,1001);
 CREATE TABLE attendance(attendance_id INT PRIMARY KEY,emp_id INT,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,status TEXT);
 INSERT INTO attendance VALUES(1,7,'2026-10-31T03:30:00Z',NULL,'present');
 CREATE TABLE self_attendance_records(id INT,ward_id INT NOT NULL,kothi_id INT);INSERT INTO self_attendance_records VALUES(1,100,1001);
 `);return db;}

test('migration final content verification catches damage after schema changes and rollback restores original punch and Ward',async()=>{
 const db=await fixture();try{
  const base=adapter(db),queries=[];let injected=false;
  const client={query:async(sql,params)=>{
   queries.push(sql);const result=await base.query(sql,params);
   if(sql.includes('ALTER COLUMN ward_id DROP NOT NULL')){await db.exec("UPDATE attendance SET emp_id=99,status='absent' WHERE attendance_id=1");injected=true;}
   return result;
  }};
  await db.exec('BEGIN');
  await assert.rejects(retireSectorMemberships(client),/Protected employee\/history\/access data changed/);
  assert.equal(injected,true);
  assert.ok(queries.some(sql=>/LOCK TABLE.*"attendance".*SHARE ROW EXCLUSIVE MODE/.test(sql)));
  await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT emp_id,status FROM attendance')).rows,[{emp_id:7,status:'present'}]);
  assert.equal((await db.query('SELECT sector_id FROM wards')).rows[0].sector_id,100);
  assert.equal((await db.query("SELECT attnotnull FROM pg_attribute WHERE attrelid='self_attendance_records'::regclass AND attname='ward_id'")).rows[0].attnotnull,true);
 }finally{await db.close();}
});

test('migration refuses unreviewed DDL event triggers and incomplete production scope schema before updates',async()=>{
 const db=await fixture();try{
  const base=adapter(db);await db.exec('BEGIN');
  await assert.rejects(retireSectorMemberships({query:(sql,params)=>sql.includes('FROM pg_event_trigger')?Promise.resolve({rows:[{evtname:'unreviewed'}]}):base.query(sql,params)}),/event triggers/);
  await db.exec('ROLLBACK;BEGIN');
  await assert.rejects(retireSectorMemberships(base,()=>{},{requireCompleteSchema:true}),/Complete production preservation checks require tables/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT sector_id FROM wards')).rows[0].sector_id,100);
 }finally{await db.close();}
});
