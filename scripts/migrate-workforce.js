// Explicit deployment step only. Never imported by login, punch or startup.
const fs=require('fs'),path=require('path');
const files=['20261023_non_duplicate_pairs.sql','20261021_workforce_review.sql','20261021_workforce_merge.sql','20261022_professional_attendance_site.sql','20261022_workforce_merge_recovery.sql','20261022_merge_weeklyoff_recovery.sql'];
if(!process.argv.includes('--apply')) {
 console.log('No database changes made. Review these migrations, then run with --apply:');
 for(const file of files)console.log(file);
}else{
 const pool=require('../config/db');
 const {migrationConnection}=require('../utils/migrationConnection');
 (async()=>{
  let client,error;
  try{
   client=await migrationConnection(pool);await client.query('BEGIN');
   await client.query("SELECT pg_advisory_xact_lock(hashtext('matrixtrack-workforce-schema'))");
   for(const file of files){client.setStep(file);await client.query(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));}
   const {references,installAliasTriggers,assertAliasTriggers}=require('../utils/workforceMerge');
   client.setStep('employee reference redirect triggers');
   for(const kind of ['regular','professional']){
    const plan={kind,links:await references(client,kind)};
    await installAliasTriggers(client,plan);await assertAliasTriggers(client,plan);
   }
   client.setStep('48-hour merge recovery journal triggers');
   await require('../utils/workforceMergeRecovery').installRecoveryTriggers(client);
   await client.query('COMMIT');console.log('Workforce schema upgrade committed. No historical attendance sites were guessed or backfilled.');
  }catch(failure){error=failure;if(client && failure.message!=='Query read timeout')try{await client.query('ROLLBACK');}catch(_){}console.error('Workforce upgrade failed:',failure.message);process.exitCode=1;}
  finally{if(client)await client.release(error);await pool.end();}
 })();
}
