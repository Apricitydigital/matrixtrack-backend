// Migration timeouts are separate from the short API query timeout. PostgreSQL
// must cancel a blocked statement before node-postgres abandons its response.
const integer=(value,fallback)=>Number.isSafeInteger(Number(value)) && Number(value)>0?Number(value):fallback;
async function migrationConnection(pool,env=process.env) {
 const raw=await pool.connect();
 const statementMs=integer(env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,120000);
 const lockMs=Math.min(integer(env.DB_MIGRATION_LOCK_TIMEOUT_MS,5000),statementMs);
 const readMs=statementMs+10000;
 let failure,previous,step='configure migration connection';
 const query=async(text,values)=>{
  try{return await raw.query(typeof text==='string'?{text,values,query_timeout:readMs}:{...text,query_timeout:readMs});}
  catch(error){failure=error;error.migrationStep=error.migrationStep || step;throw error;}
 };
 try{
  previous=(await query(`SELECT current_setting('statement_timeout') AS statement_timeout,
   current_setting('lock_timeout') AS lock_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
   current_setting('application_name') AS application_name`)).rows[0];
  await query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),
   set_config('idle_in_transaction_session_timeout','60000ms',false),set_config('application_name','matrixtrack-startup-migrations',false)`,[`${statementMs}ms`,`${lockMs}ms`]);
 }catch(error){raw.release(error);throw error;}
 return {
  query,setStep(value){step=value;},
  async release(error){
   failure=error || failure;
   if(!failure)try{
    await query(`SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),
     set_config('idle_in_transaction_session_timeout',$3,false),set_config('application_name',$4,false)`,
    [previous.statement_timeout,previous.lock_timeout,previous.idle_timeout,previous.application_name]);
   }catch(restoreError){failure=restoreError;}
   // Never put a timed-out or aborted transaction back into the API pool.
   raw.release(failure);
  },
 };
}
module.exports={migrationConnection};
