// Explicit user-authorized real-data test. Default is a rolled-back rehearsal.
// Never logs credentials, Aadhaar values, face data or profile snapshots.
require('dotenv').config({quiet:true});
const assert=require('node:assert/strict');
const {Client}=require('pg');
const merge=require('../utils/workforceMerge');
const recovery=require('../utils/workforceMergeRecovery');
const {retainMergedLogins}=require('../utils/professionalMergeLogin');
const {fingerprint,quote}=require('../utils/workforceReview');
const main='63285616-8cb6-4b0e-b9b0-d6451270350c';
const duplicate='d4135905-921b-4994-884d-027492e27645';
const client=new Client({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,statement_timeout:30000});
let committedMerge=null;
async function begin(){await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");}
async function state(){
 const result={};
 const scope=[main,duplicate];
 for(const link of await merge.references(client,'professional')){
  const rows=(await client.query(`SELECT to_jsonb(t) AS row FROM ${quote(link.table)} t WHERE ${quote(link.column)}::text=ANY($1::text[])`,[scope])).rows;
  result[`${link.table}.${link.column}`]=rows.map(row=>fingerprint(row.row)).sort();
 }
 for(const [table,sql,params] of [
  ['profiles','SELECT to_jsonb(t) AS row FROM professional_employees t WHERE id::text=ANY($1::text[])',[scope]],
  ['id_aliases',"SELECT to_jsonb(t) AS row FROM workforce_employee_aliases t WHERE employee_kind='professional' AND (source_id=ANY($1::text[]) OR target_id=ANY($1::text[]))",[scope]],
  ['login_aliases','SELECT to_jsonb(t) AS row FROM workforce_professional_login_aliases t WHERE source_id=ANY($1::text[]) OR target_id::text=ANY($1::text[])',[scope]],
  ['issues',"SELECT to_jsonb(t) AS row FROM workforce_review_issues t WHERE employee_kind='professional' AND employee_id=ANY($1::text[])",[scope]],
  ['regular_profiles',"SELECT to_jsonb(t) AS row FROM employee t WHERE emp_id IN (30624,31280)",[]],
  ['regular_attendance',"SELECT to_jsonb(t) AS row FROM attendance t WHERE emp_id IN (30624,31280)",[]],
 ])result[table]=(await client.query(sql,params)).rows.map(row=>fingerprint(row.row)).sort();
 return result;
}
async function prepare(){
 const plan=await merge.mergePlan(client,'professional',main,[duplicate]);
 assert.equal(plan.profiles.length,2);
 for(const row of plan.profiles)assert.equal(row.full_name.trim().toLowerCase(),'ashu test','Only the explicitly authorized Ashu test profiles may be changed');
 await merge.assertAliasTriggers(client,plan);await recovery.assertRecoveryReady(client,plan);
 await client.query('SAVEPOINT diagnose_move');
 try{await merge.moveReferences(client,plan);}
 catch(error){await client.query('ROLLBACK TO SAVEPOINT diagnose_move');throw new Error(`Dependency conflict: table=${error.table || 'unknown'}, constraint=${error.constraint || 'unknown'}, code=${error.code || 'unknown'}`);}
 await client.query('ROLLBACK TO SAVEPOINT diagnose_move');await client.query('RELEASE SAVEPOINT diagnose_move');
 await merge.validateMove(client,plan);
 return plan;
}
async function apply(plan,actor){
 const audit=await recovery.beginRecovery(client,plan,actor,'User-authorized Ashu test merge/revert verification; restore immediately after checking');
 assert.deepEqual(plan.weeklyOff.days,[],'The main account keeps its own weekly-off schedule');
 await merge.moveReferences(client,plan);await retainMergedLogins(client,plan);
 for(const source of plan.profiles.filter(row=>row.id!==main)){
  await client.query("UPDATE workforce_employee_aliases SET target_id=$1 WHERE employee_kind='professional' AND target_id=$2",[main,source.id]);
  await client.query("INSERT INTO workforce_employee_aliases(employee_kind,source_id,target_id,emp_code,face_id) VALUES('professional',$1,$2,$3,$4)",[source.id,main,source.emp_code || null,source.face_id || null]);
 }
 await client.query('DELETE FROM professional_employees WHERE id=$1',[duplicate]);
 assert.deepEqual((await client.query('SELECT week_off_days FROM professional_week_off WHERE professional_id=$1',[main])).rows[0].week_off_days,[]);
 await client.query("SELECT set_config('matrixtrack.merge_id','',true)");
 assert.equal((await client.query('SELECT 1 FROM professional_employees WHERE id=$1',[duplicate])).rows.length,0);
 assert.equal((await client.query('SELECT target_id FROM workforce_employee_aliases WHERE source_id=$1',[duplicate])).rows[0].target_id,main);
 return audit;
}
async function restore(id,actor){
 const audit=await recovery.auditForRestore(client,id);
 const preview=await recovery.previewRestore(client,audit);
 assert.ok(preview.fingerprint);
 await recovery.replayUndo(client,audit);
 await recovery.auditForRestore(client,id);
 await client.query('UPDATE workforce_merge_audit SET reverted_at=clock_timestamp(),reverted_by=$2,revert_reason=$3 WHERE id=$1',[id,actor,'User-authorized verification complete; restoring Ashu test original profiles and records']);
 return preview;
}
(async()=>{
 try{
  await client.connect();
  const owners=[process.env.SUPER_ADMIN_EMAIL || 'mtadmin@apricitydigital.in',process.env.SUPER_ADMIN_DB_EMAIL || 'admin@gmail.com'].map(value=>value.toLowerCase());
  const actor=(await client.query("SELECT user_id FROM users WHERE LOWER(TRIM(email))=ANY($1::text[]) AND role IN ('admin','super_admin','superadmin') AND COALESCE(is_deleted,false)=false ORDER BY user_id LIMIT 1",[owners])).rows[0]?.user_id;
  assert.ok(actor,'Configured deployment owner must exist for an attributable audit');
  await begin();const baseline=await state();const plan=await prepare();
  const audit=await apply(plan,actor);await restore(audit.id,actor);
  assert.deepEqual(await state(),baseline,'Rehearsal must restore every scoped row and both regular profiles exactly');
  await client.query('ROLLBACK');
  console.log('PASS: real Ashu test data: merge + recovery rehearsal rolled back; before/after fingerprints identical.');
  if(!process.argv.includes('--apply')){console.log('No employee changes committed. Use --apply only for the explicitly authorized real merge followed by immediate revert.');return;}
  await begin();assert.deepEqual(await state(),baseline,'Records changed since rehearsal');
  const actualPlan=await prepare();const actual=await apply(actualPlan,actor);
  await client.query('COMMIT');committedMerge=actual.id;
  console.log('Real merge committed. Merge reference: '+actual.id);
  await begin();const preview=await restore(actual.id,actor);
  assert.deepEqual(await state(),baseline,'Restored data differs from before merge; stop and investigate');
  await client.query('COMMIT');committedMerge=null;
  console.log(JSON.stringify({result:'PASS',mergeId:actual.id,reverted:true,comparedScopes:Object.keys(baseline).length,reversedTables:preview.affected.map(item=>item.table),originalProfilesAndRelatedRows:'exact match',regularEmployees:'unchanged'}));
 }catch(error){
  try{await client.query('ROLLBACK');}catch(_){}
  console.error('Verification stopped: '+error.message);
  if(committedMerge)console.error('ACTION REQUIRED: merge '+committedMerge+' was committed and remains recoverable. Do not discard its journal.');
  process.exitCode=1;
 }finally{await client.end();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
