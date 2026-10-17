const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');
const {PGlite}=require('../../scratch/weekly-off-verification/node_modules/@electric-sql/pglite');
async function main(){const db=new PGlite();try{
  await db.exec(`CREATE TABLE department(department_id INT PRIMARY KEY,department_name TEXT);
    CREATE TABLE designation(designation_id INT PRIMARY KEY,designation_name TEXT,department_id INT REFERENCES department,UNIQUE(department_id,designation_name));
    CREATE TABLE professional_designation_assignments(professional_id UUID,designation_id INT REFERENCES designation,assigned_by INT,assigned_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(professional_id,designation_id));
    CREATE TABLE employee(emp_id INT PRIMARY KEY,designation_id INT REFERENCES designation);
    INSERT INTO department VALUES(1,'Professional'),(2,'Other');
    INSERT INTO designation VALUES(1,'Country Head',1),(2,'Country Head',2);
    INSERT INTO professional_designation_assignments VALUES('00000000-0000-4000-8000-000000000001',1,99,NOW());
    INSERT INTO employee VALUES(1,1);`);
  const sql=fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_hod.sql'),'utf8');await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query('SELECT designation_name FROM designation WHERE designation_id=1')).rows[0].designation_name,'Head of Department');
  assert.equal((await db.query('SELECT designation_id FROM employee WHERE emp_id=1')).rows[0].designation_id,1);
  assert.equal((await db.query('SELECT designation_name FROM designation WHERE designation_id=2')).rows[0].designation_name,'Country Head','Other departments are unchanged');
  await db.exec(`INSERT INTO designation VALUES(3,'Country Head',1);
    INSERT INTO professional_designation_assignments VALUES('00000000-0000-4000-8000-000000000001',3,77,NOW()),('00000000-0000-4000-8000-000000000002',3,77,NOW());
    INSERT INTO employee VALUES(2,3);`);
  await db.exec(sql);await db.exec(sql);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM professional_designation_assignments WHERE designation_id=1')).rows[0].n,2);
  assert.equal((await db.query('SELECT designation_id FROM employee WHERE emp_id=2')).rows[0].designation_id,1);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM designation WHERE designation_id=3')).rows[0].n,0);
  assert.equal((await db.query("SELECT assigned_by FROM professional_designation_assignments WHERE professional_id='00000000-0000-4000-8000-000000000001'")).rows[0].assigned_by,99);
  console.log('PASS: HOD rename preserves IDs/assignments, merges existing HOD safely, redirects primary FKs and is idempotent.');
}finally{await db.close();}}
main().catch(error=>{console.error(error);process.exitCode=1;});
