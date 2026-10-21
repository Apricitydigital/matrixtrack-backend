// Production-shaped UUID and TIMESTAMPTZ fixture; no application .env/live DB.
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {attendanceMergePlan,consolidateAttendance}=require('../utils/workforceAttendanceMerge');
const db=new PGlite();
const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
const attendanceIds=['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002'];
(async()=>{
 await db.exec(`CREATE TABLE professional_attendance(
 id UUID PRIMARY KEY,professional_id UUID NOT NULL,date DATE NOT NULL,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ,
 city_id INT NOT NULL DEFAULT 1,punch_approval_status TEXT NOT NULL DEFAULT 'accepted',
 metadata JSONB,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(professional_id,date),
 CHECK(punch_out IS NULL OR punch_out>=punch_in));
 CREATE TABLE evidence(id SERIAL PRIMARY KEY,attendance_id UUID REFERENCES professional_attendance);
 CREATE TABLE legacy_evidence(id SERIAL PRIMARY KEY,attendance_id UUID,note TEXT);`);
 await db.query(`INSERT INTO professional_attendance(id,professional_id,date,punch_in,punch_out,metadata) VALUES
 ($1,$2,'2026-10-01','2026-10-01 09:00+05:30',NULL,'{"device":"same","accuracy":1}'),
 ($3,$4,'2026-10-01','2026-10-01 03:30+00','2026-10-01 12:30+00','{"accuracy":1,"device":"same"}')`,[attendanceIds[0],ids[0],attendanceIds[1],ids[1]]);
 await db.query('INSERT INTO evidence(attendance_id) VALUES($1)',[attendanceIds[1]]);
 await db.query("INSERT INTO legacy_evidence(attendance_id,note) VALUES($1,'retain original evidence')",[attendanceIds[1]]);
 await db.query('BEGIN');
 const plan=await attendanceMergePlan(db,ids,ids[0]);
 assert.deepEqual(plan.summary,{originalRows:2,uniqueDays:1,overlapDays:1,consolidatedRows:1});
 assert.equal(plan.groups[0].originals.length,2);
 const oldDigest=plan.links.find(link=>link.table==='legacy_evidence').state.digest;
 await db.query("UPDATE legacy_evidence SET note='updated during review'");
 const changedPlan=await attendanceMergePlan(db,ids,ids[0]);
 assert.notEqual(changedPlan.links.find(link=>link.table==='legacy_evidence').state.digest,oldDigest,'non-FK child changes must invalidate the merge fingerprint');
 await consolidateAttendance(db,changedPlan);await db.query('COMMIT');
 const rows=(await db.query('SELECT to_jsonb(a) AS row FROM professional_attendance a')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].row.id,attendanceIds[0]);
 assert.equal(Date.parse(rows[0].row.punch_in),Date.parse('2026-10-01T09:00:00+05:30'));
 assert.equal(Date.parse(rows[0].row.punch_out),Date.parse('2026-10-01T18:00:00+05:30'));
 assert.equal((await db.query('SELECT attendance_id FROM evidence')).rows[0].attendance_id,attendanceIds[0]);
 assert.equal((await db.query('SELECT attendance_id FROM legacy_evidence')).rows[0].attendance_id,attendanceIds[0]);
 console.log('PASS: real UUID attendance IDs, equivalent timezone instants, JSON metadata equality, complementary punches, FK and non-FK evidence preservation and evidence-change fingerprints.');
 await db.close();
})().catch(async error=>{console.error(error);await db.close();process.exitCode=1;});
