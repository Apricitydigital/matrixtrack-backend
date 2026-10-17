const fs=require('fs');const path=require('path');const {Client}=require('pg');
require('dotenv').config({path:path.join(__dirname,'../.env')});
async function main(){
  const apply=process.argv.includes('--apply');
  const client=new Client({user:process.env.DB_USER,password:process.env.DB_PASSWORD,host:process.env.DB_HOST,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||5432),ssl:{rejectUnauthorized:false},connectionTimeoutMillis:5000});
  try{
    await client.connect();await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");await client.query("SET LOCAL statement_timeout='15s'");
    const query=`SELECT d.designation_id,d.designation_name,(SELECT COUNT(*)::int FROM professional_designation_assignments a WHERE a.designation_id=d.designation_id) AS assignments
      FROM designation d JOIN department dep ON dep.department_id=d.department_id
      WHERE LOWER(TRIM(dep.department_name))='professional' AND LOWER(TRIM(d.designation_name)) IN ('country head','head of department') ORDER BY d.designation_id`;
    const before=(await client.query(query)).rows;
    await client.query(fs.readFileSync(path.join(__dirname,'../db/migrations/20261016_professional_hod.sql'),'utf8'));
    const after=(await client.query(query)).rows;
    await client.query(apply?'COMMIT':'ROLLBACK');
    console.log(JSON.stringify({applied:apply,before,after}));
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{await client.end();}
}
main().catch(error=>{console.error('HOD migration failed:',error.code||error.message);process.exitCode=1;});
