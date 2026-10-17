// Isolated integration fixture; all schema/data changes are rolled back.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
let pool;
if (process.argv.includes('--local-pg')) {
  const { PGlite } = require(process.env.WEEKLY_OFF_PGLITE_PATH || '@electric-sql/pglite');
  const db = new PGlite();
  const client = { release() {}, query: async (sql, params = []) => params.length ? db.query(sql, params) : (await db.exec(sql)).at(-1) || { rows: [] } };
  pool = { connect: async () => client, end: () => db.close() };
} else { pool = require('../config/db'); }
async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `verify_weekly_off_${Date.now()}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE department(department_id SERIAL PRIMARY KEY,department_name TEXT);
      CREATE TABLE designation(designation_id SERIAL PRIMARY KEY,designation_name TEXT,department_id INT REFERENCES department);
      CREATE TABLE permissions(id SERIAL PRIMARY KEY,module TEXT,action TEXT);
      CREATE TABLE users(user_id SERIAL PRIMARY KEY,name TEXT);
      CREATE TABLE cities(city_id SERIAL PRIMARY KEY,city_name TEXT);
      CREATE TABLE zones(zone_id SERIAL PRIMARY KEY,city_id INT,zone_name TEXT);
      CREATE TABLE sectors(sector_id SERIAL PRIMARY KEY,zone_id INT);
      CREATE TABLE wards(ward_id SERIAL PRIMARY KEY,ward_name TEXT,zone_id INT,sector_id INT);
      CREATE TABLE professional_employees(id UUID PRIMARY KEY,full_name TEXT,emp_code TEXT,city_id INT,zone_id INT,ward_id INT,kothi_id INT,is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE professional_attendance(id SERIAL PRIMARY KEY,professional_id UUID,date DATE,punch_in TIMESTAMPTZ,punch_out TIMESTAMPTZ);
      CREATE TABLE professional_leave_requests(id SERIAL PRIMARY KEY,professional_id UUID,requested_date DATE,status TEXT);
      CREATE TABLE professional_holidays(id SERIAL PRIMARY KEY,holiday_date DATE,city_id INT,zone_id INT,ward_id INT,kothi_id INT);
      CREATE TABLE professional_week_off(id UUID DEFAULT gen_random_uuid() PRIMARY KEY,professional_id UUID UNIQUE REFERENCES professional_employees,week_off_days INT[] DEFAULT '{}',created_by INT,updated_by INT,updated_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO professional_employees(id,full_name,emp_code,city_id,kothi_id) VALUES
      ('00000000-0000-4000-8000-000000000001','Employee','E1',1,1),
      ('00000000-0000-4000-8000-000000000002','Coordinator','C1',1,1);
      INSERT INTO professional_week_off(professional_id,week_off_days) VALUES('00000000-0000-4000-8000-000000000001',ARRAY[1]);
    `);
    const migration = fs.readFileSync(path.join(__dirname,'../db/migrations/20261009_professional_weekly_off.sql'),'utf8');
    await client.query(migration);
    await client.query(migration);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM designation')).rows[0].n,3);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM permissions')).rows[0].n,2);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_week_off_versions')).rows[0].n,1);
    await client.query(`UPDATE professional_week_off SET week_off_days=ARRAY[2],effective_from='2026-10-13',updated_by_professional='00000000-0000-4000-8000-000000000002' WHERE professional_id='00000000-0000-4000-8000-000000000001'`);
    const { rows } = await client.query(`SELECT professional_is_week_off('00000000-0000-4000-8000-000000000001',d::date) AS off FROM UNNEST(ARRAY['2026-10-12'::date,'2026-10-13'::date,'2026-10-19'::date,'2026-10-20'::date]) d`);
    assert.deepEqual(rows.map(r=>r.off),[true,true,false,true]);
    await client.query(`INSERT INTO professional_attendance(professional_id,date,punch_in) VALUES ('00000000-0000-4000-8000-000000000001','2026-10-13','2026-10-13T09:00:00+05:30');
      INSERT INTO professional_leave_requests(professional_id,requested_date,status) VALUES ('00000000-0000-4000-8000-000000000001','2026-10-13','approved');
      INSERT INTO professional_holidays(holiday_date,city_id) VALUES('2026-10-13',1);`);
    const paid = await client.query(`SELECT COUNT(*)::int AS n FROM generate_series('2026-10-13'::date,'2026-10-14'::date,'1 day') d WHERE professional_is_paid_day('00000000-0000-4000-8000-000000000001',d::date)`);
    assert.equal(paid.rows[0].n,1,'overlapping weekly off, punch, leave and holiday count as one paid date');
    const log = (await client.query("SELECT old_days,week_off_days,source,actor_professional_id FROM professional_week_off_versions ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(log.old_days,[1]); assert.deepEqual(log.week_off_days,[2]); assert.equal(log.source,'coordinator');
    await client.query(`INSERT INTO professional_designation_assignments(professional_id,designation_id)
      SELECT '00000000-0000-4000-8000-000000000002',designation_id FROM designation WHERE designation_name IN ('HO Coordinator','Head of Department')`);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM professional_designation_assignments')).rows[0].n,2);
    await require('../tests/professionalWeeklyOffRoutes.integration')(client);
    await require('../tests/professionalWeeklyOffReports.integration')(client);
    console.log('PASS: migration idempotence, multiple designations, dated history, coordinator audit and overlap-safe paid days.');
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
}
main().catch(e=>{ console.error('Weekly-off verification failed:',e.stack || e.message); process.exitCode=1; pool.end().catch(()=>{}); });
