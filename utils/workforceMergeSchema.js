// Deployment/migration code only. Employee requests must never install triggers.
async function refreshMergeTriggers(client) {
 const ready=(await client.query(`SELECT to_regclass('workforce_employee_aliases') IS NOT NULL
 AND to_regprocedure('workforce_redirect_employee_reference()') IS NOT NULL
 AND to_regclass('workforce_merge_changes') IS NOT NULL
 AND to_regprocedure('workforce_capture_merge_change()') IS NOT NULL AS ready`)).rows[0]?.ready;
 if(!ready)return false;
 const {references,installAliasTriggers,assertAliasTriggers}=require('./workforceMerge');
 const {recoveryTables}=require('./workforceMergeRecovery');
 const {quote}=require('./workforceReview');
 for(const kind of ['regular','self_attendance']){
  const plan={kind,links:await references(client,kind)};
  await installAliasTriggers(client,plan);
  await assertAliasTriggers(client,plan);
  if((await client.query("SELECT to_regprocedure('workforce_block_cross_attendance_write()') IS NOT NULL AS ready")).rows[0]?.ready){
   for(const link of plan.links){
    const name='cross_'+require('crypto').createHash('sha256').update(`${kind}:${link.table}:${link.column}`).digest('hex').slice(0,24);
    if(!(await client.query('SELECT 1 FROM pg_trigger WHERE tgname=$1 AND tgrelid=to_regclass($2)',[name,quote(link.table)])).rows.length)
     await client.query(`CREATE TRIGGER ${quote(name)} BEFORE INSERT OR UPDATE OF ${quote(link.column)} ON ${quote(link.table)} FOR EACH ROW EXECUTE FUNCTION workforce_block_cross_attendance_write('${kind}','${link.column.replace(/'/g,"''")}')`);
   }
  }
 }
 for(const table of await recoveryTables(client)){
  const trigger=(await client.query(`SELECT tgenabled,
   tgfoid=to_regprocedure('workforce_capture_merge_change()') AS correct
   FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname='workforce_capture_merge_change'`,[quote(table)])).rows[0];
  if(trigger && (!trigger.correct || !['O','A'].includes(trigger.tgenabled)))
   throw Error('Merge recovery trigger requires review: '+table);
  if(!trigger)await client.query(`CREATE TRIGGER workforce_capture_merge_change
   AFTER INSERT OR UPDATE OR DELETE ON ${quote(table)}
   FOR EACH ROW EXECUTE FUNCTION workforce_capture_merge_change()`);
 }
 return true;
}
module.exports={refreshMergeTriggers};
