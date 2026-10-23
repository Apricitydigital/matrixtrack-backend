const {aadhaar}=require('./workforceAadhaar');
const {quote, fingerprint, deletionPlan} = require('./workforceReview');
const {attendanceMergePlan,consolidateAttendance}=require('./workforceAttendanceMerge');
const reject = message => { throw Object.assign(new Error(message), {status:409}); };
const normalized = value => String(value || '').trim().toLowerCase().replace(/\s+/g,' ');
const mobile = value => String(value || '').replace(/\D/g,'').replace(/^91(?=\d{10}$)/,'');
function matchingSignals(a,b) {
 if(a.kind!==b.kind)return [];
 return [aadhaar(a.aadhaar_number) && aadhaar(a.aadhaar_number)===aadhaar(b.aadhaar_number) && 'Same Aadhaar',normalized(a.name) && normalized(a.name)===normalized(b.name) && 'Same name',
 mobile(a.mobile).length>=10 && mobile(a.mobile)===mobile(b.mobile) && 'Same mobile'].filter(Boolean);
}
// Indexed buckets avoid comparing every pair in large directories. Candidates are
// direct matches; a shared name never silently joins a transitive identity group.
function duplicateIndex(rows) {
 const index=new Map();
 for(const row of rows) for(const key of candidateKeys(row)) {
  if(!index.has(key)) index.set(key,[]);
  index.get(key).push(row);
 }
 return row => [...new Map(candidateKeys(row).flatMap(key=>index.get(key)||[])
  .filter(other=>other.kind===row.kind && other.id!==row.id).map(other=>[`${other.kind}:${other.id}`,other])).values()];
}
function candidateKeys(row) {
 return [aadhaar(row.aadhaar_number) && `a:${aadhaar(row.aadhaar_number)}`,normalized(row.name) && `n:${normalized(row.name)}`,mobile(row.mobile).length>=10 && `m:${mobile(row.mobile)}`].filter(Boolean);
}
async function references(client,kind) {
 const table=kind==='regular'?'employee':'professional_employees';
 const links=(await client.query(`SELECT child.relname AS "table",ca.attname AS "column",pa.attname AS parent_column,
 cardinality(f.conkey) AS columns,child_ns.nspname=current_schema() AS local
 FROM pg_constraint f JOIN pg_class parent ON parent.oid=f.confrelid
 JOIN pg_namespace ns ON ns.oid=parent.relnamespace JOIN pg_class child ON child.oid=f.conrelid
 JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
 JOIN pg_attribute ca ON ca.attrelid=f.conrelid AND ca.attnum=f.conkey[1]
 JOIN pg_attribute pa ON pa.attrelid=f.confrelid AND pa.attnum=f.confkey[1]
 WHERE f.contype='f' AND ns.nspname=current_schema() AND parent.relname=$1`,[table])).rows;
 if(links.some(link=>!link.local || link.columns!==1 || link.parent_column!==(kind==='regular'?'emp_id':'id'))) reject('This employee has dependencies that require a manual migration.');
 // Older installations also have employee references without foreign keys.
 const loose=(await client.query(`SELECT c.table_name AS "table",c.column_name AS "column" FROM information_schema.columns c
 JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
 WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE' AND c.column_name=ANY($1::text[]) AND c.table_name<>$2
 AND c.data_type=ANY($3::text[])`,[kind==='regular'?['emp_id','employee_id']:['professional_id','actor_professional_id','updated_by_professional','pm_reviewer_id','ho_reviewer_id','hod_reviewer_id'],table,kind==='regular'?['integer','bigint']:['uuid']])).rows;
 return [...new Map([...links,...loose].filter(link=>link.table!=='workforce_professional_login_aliases').map(link=>[`${link.table}:${link.column}`,{table:link.table,column:link.column}])).values()].sort((a,b)=>`${a.table}:${a.column}`.localeCompare(`${b.table}:${b.column}`));
}
async function mergePlan(client,kind,targetId,sourceIds,options={}) {
 const table=kind==='regular'?'employee':'professional_employees',key=kind==='regular'?'emp_id':'id';
 const ids=[targetId,...sourceIds];
 if(kind==='professional' && require('../config/professionalAttendanceIdentities').some(group=>group.profileIds.some(id=>ids.includes(id)))) reject('These profiles already use reviewed attendance identity links. Reconcile those links before permanently merging their IDs.');
 const profiles=(await client.query(`SELECT * FROM ${quote(table)} WHERE ${quote(key)}::text=ANY($1::text[]) ORDER BY ${quote(key)} FOR UPDATE`,[ids])).rows;
 if(profiles.length!==ids.length) reject('One of these employees changed or was already merged. Refresh the directory.');
 const target=profiles.find(row=>String(row[key])===targetId),sources=profiles.filter(row=>String(row[key])!==targetId);
 if(target.is_active===false || target.is_deleted===true) reject('Choose an active, non-deleted main employee ID.');
 if(kind==='professional' && !target.selfie_url) reject('Choose a main account with a working enrolled face so the employee can continue punching.');
 const site=kind==='regular'?'ward_id':'kothi_id';
 for(const source of sources) {
  if(source[site]!==target[site] || (kind==='professional' && source.city_id!==target.city_id)) reject('Employees must belong to the same city and site before merging.');
  // The chosen main profile keeps its credentials and enrolled face. Retired
  // professional credentials are retained separately, with reset invalidation.
  const fields=kind==='professional'?['is_active']:['face_embedding','self_attendance_enabled'];
  for(const field of fields) if(JSON.stringify(source[field]??null)!==JSON.stringify(target[field]??null)) reject(`Different ${field.replace(/_/g,' ')} details: reconcile these before merging so login and punch-in remain available.`);
  if(kind==='regular' && source.face_id && !target.face_id) reject('Choose a main employee with an enrolled face to preserve face punch-in.');
  if(kind==='professional' && source.is_deleted===true) reject('Deleted accounts require a separate identity review before merging.');
 }
 const links=await references(client,kind),affected=[];
 const attendanceTable=kind==='regular'?'attendance':'professional_attendance',attendanceKey=kind==='regular'?'emp_id':'professional_id';
 const overlaps=await client.query(`SELECT date::date FROM ${quote(attendanceTable)} WHERE ${quote(attendanceKey)}::text=ANY($1::text[]) GROUP BY date::date HAVING count(DISTINCT ${quote(attendanceKey)})>1 LIMIT 1`,[ids]);
 if(kind==='regular' && overlaps.rows.length) reject('These IDs have attendance on the same date. Review the overlapping attendance before merging; no punches will be overwritten.');
 const attendance=kind==='professional'?await attendanceMergePlan(client,ids,targetId):null;
 for(const link of links) {
  const state=(await client.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM ${quote(link.table)} t WHERE ${quote(link.column)}::text=ANY($1::text[])`,[ids])).rows[0];
  if(state.count) affected.push({...link,...state});
 }
 const plans=[];
 for(const id of ids) plans.push(await deletionPlan(client,kind,id));
 const loginAliases=kind==='professional'?(await client.query('SELECT * FROM workforce_professional_login_aliases WHERE target_id::text=ANY($1::text[]) ORDER BY source_id',[ids])).rows:[];
 const login=kind==='professional'?{mainId:targetId,name:target.full_name,email:target.email || null,mobile:target.mobile || null,retainedAccounts:sourceIds.length,mainCredentialsPreserved:true,existingSessionsPreserved:true,faceReference:'main'}:null;
 const weeklyOff=await require('./professionalMergeWeeklyOff').weeklyOffPlan(client,kind,ids,options.weeklyOffSourceId);
 return {kind,targetId,sourceIds,profiles,links,affected,attendance,login,weeklyOff,fingerprint:fingerprint({profiles,affected,plans,attendance,loginAliases,weeklyOff})};
}
async function moveReferences(client,plan) {
 await require('./professionalMergeWeeklyOff').consolidateWeeklyOff(client,plan.weeklyOff);
 if(plan.kind==='professional'){
  const settings=new Set(['professional_designation_assignments','professional_site_access','professional_geofences','professional_leave_allocations','professional_punch_cutoffs','professional_attendance_blocks']);
  for(const table of settings)if(plan.links.some(link=>link.table===table && link.column==='professional_id'))
   await client.query(`DELETE FROM ${quote(table)} WHERE professional_id::text=ANY($1::text[])`,[plan.sourceIds]);
 }
 await consolidateAttendance(client,plan.attendance);
 for(const link of plan.links) await client.query(`UPDATE ${quote(link.table)} SET ${quote(link.column)}=$1 WHERE ${quote(link.column)}::text=ANY($2::text[])`,[plan.targetId,plan.sourceIds]);
 await client.query(`UPDATE workforce_review_issues SET employee_id=$1,updated_at=NOW() WHERE employee_kind=$2 AND employee_id=ANY($3::text[])`,[plan.targetId,plan.kind,plan.sourceIds]);
}
async function validateMove(client,plan) {
 await client.query('SAVEPOINT merge_validation');
 try { await moveReferences(client,plan); }
 catch(error) {
  await client.query('ROLLBACK TO SAVEPOINT merge_validation');
  if(['23505','23514','23503'].includes(error.code)) reject('Attendance dates or dependent settings conflict. Nothing was changed. Review these records before merging.');
  throw error;
 }
 await client.query('ROLLBACK TO SAVEPOINT merge_validation');
 await client.query('RELEASE SAVEPOINT merge_validation');
}
const aliasTriggerName=(kind,link)=>`workforce_alias_${require('crypto').createHash('sha256').update(`${kind}:${link.table}:${link.column}`).digest('hex').slice(0,24)}`;
async function assertAliasTriggers(client,plan) {
 for(const link of plan.links){
  const {rows}=await client.query(`SELECT 1 FROM pg_trigger WHERE tgname=$1 AND tgrelid=to_regclass($2)
   AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('workforce_redirect_employee_reference()')`,[aliasTriggerName(plan.kind,link),quote(link.table)]);
  if(!rows.length)throw Object.assign(new Error('Employee merge requires the workforce schema upgrade for its dependent tables. No records were changed.'),{status:503});
 }
}
async function installAliasTriggers(client,plan) {
 for(const link of plan.links) {
  // Identifiers are quoted; the function arguments come only from this catalog
  // and the validated employee kind, never from request-provided SQL fragments.
  const name=aliasTriggerName(plan.kind,link);
  if((await client.query('SELECT 1 FROM pg_trigger WHERE tgname=$1 AND tgrelid=to_regclass($2)',[name,quote(link.table)])).rows.length) continue;
  await client.query(`CREATE TRIGGER ${quote(name)} BEFORE INSERT OR UPDATE OF ${quote(link.column)} ON ${quote(link.table)} FOR EACH ROW EXECUTE FUNCTION workforce_redirect_employee_reference('${plan.kind}','${link.column.replace(/'/g,"''")}')`);
 }
}
module.exports={matchingSignals,duplicateIndex,mergePlan,moveReferences,validateMove,installAliasTriggers,assertAliasTriggers,references};
