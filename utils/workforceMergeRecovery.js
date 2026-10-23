const {quote,fingerprint}=require('./workforceReview');
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const same=(a,b)=>fingerprint(a ?? null)===fingerprint(b ?? null);
const triggerName='workforce_capture_merge_change';

async function ensureRecoverySchema(client) {
 const {rows}=await client.query(`SELECT to_regclass('workforce_merge_changes') IS NOT NULL
 AND to_regprocedure('workforce_capture_merge_change()') IS NOT NULL
 AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
 AND table_name='workforce_merge_audit' AND column_name='recovery_version') AS available`);
 if(!rows[0]?.available)fail('48-hour merge recovery requires the workforce schema upgrade. No records were changed.',503);
}

// Discover physical tables only. Views must never get row-write triggers.
// Include descendants because consolidating attendance may move their FKs.
async function recoveryTables(client) {
 const {references}=require('./workforceMerge');
 const roots=new Set(['employee','professional_employees','workforce_employee_aliases','workforce_professional_login_aliases','workforce_review_issues']);
 for(const kind of ['regular','professional'])for(const link of await references(client,kind))roots.add(link.table);
 const {rows}=await client.query(`WITH RECURSIVE dependencies AS (
 SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])
 UNION SELECT f.conrelid FROM pg_constraint f JOIN dependencies d ON f.confrelid=d.oid WHERE f.contype='f'
 ) SELECT DISTINCT c.relname AS name FROM dependencies d JOIN pg_class c ON c.oid=d.oid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()
 UNION SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
 ON t.table_schema=c.table_schema AND t.table_name=c.table_name
 WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE'
 AND c.column_name IN ('professional_attendance_id','attendance_id') ORDER BY name`,[[...roots]]);
 return rows.map(row=>row.name).filter(name=>!['workforce_merge_audit','workforce_merge_changes','workforce_deletion_audit'].includes(name));
}
async function installRecoveryTriggers(client) {
 for(const table of await recoveryTables(client)) {
  await client.query(`DROP TRIGGER IF EXISTS ${quote(triggerName)} ON ${quote(table)}`);
  await client.query(`CREATE TRIGGER ${quote(triggerName)} AFTER INSERT OR UPDATE OR DELETE ON ${quote(table)}
   FOR EACH ROW EXECUTE FUNCTION workforce_capture_merge_change()`);
 }
}
async function assertRecoveryReady(client,plan) {
 await ensureRecoverySchema(client);
 const tables=new Set([plan.kind==='regular'?'employee':'professional_employees',
 'workforce_employee_aliases','workforce_professional_login_aliases','workforce_review_issues',
 ...plan.links.map(link=>link.table),...(plan.attendance?.links || []).map(link=>link.table)]);
 const missing=[];
 for(const table of tables)if(!(await client.query(`SELECT 1 FROM pg_trigger WHERE tgname=$1 AND tgrelid=to_regclass($2)
 AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('workforce_capture_merge_change()')`,[triggerName,quote(table)])).rows.length)missing.push(table);
 if(missing.length)fail(`48-hour merge recovery is not ready for: ${missing.join(', ')}. Run the workforce schema upgrade. No records were changed.`,503);
 const pending=await client.query(`SELECT id FROM workforce_merge_audit WHERE employee_kind=$1 AND reverted_at IS NULL
 AND recovery_version=1 AND restore_until>clock_timestamp()
 AND (target_id=ANY($2::text[]) OR source_ids && $2::text[]) LIMIT 1`,[plan.kind,[plan.targetId,...plan.sourceIds]]);
 if(pending.rows.length)fail('An employee in this selection already has a recoverable merge. Revert that merge first or wait until its 48-hour window ends.');
}

async function beginRecovery(client,plan,actor,reason) {
 const result=await client.query(`INSERT INTO workforce_merge_audit(employee_kind,target_id,source_ids,actor_user_id,reason,profile_snapshots,affected_rows,attendance_snapshots,recovery_version,restore_until)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,clock_timestamp()+INTERVAL '48 hours') RETURNING id,restore_until`,
 [plan.kind,plan.targetId,plan.sourceIds,actor,reason,JSON.stringify(plan.profiles),JSON.stringify(plan.affected),JSON.stringify(plan.attendance?.groups.flatMap(group=>group.originals) || [])]);
 const audit=result.rows[0];
 await client.query("SELECT set_config('matrixtrack.merge_id',$1,true)",[String(audit.id)]);
 return audit;
}

async function auditForRestore(client,id) {
 if(!/^\d+$/.test(String(id)))fail('Invalid merge reference.',400);
 await ensureRecoverySchema(client);
 const {rows}=await client.query(`SELECT *,restore_until>clock_timestamp() AS in_window FROM workforce_merge_audit WHERE id=$1 FOR UPDATE`,[id]);
 const audit=rows[0];
 if(!audit)fail('Merge not found.',404);
 if(audit.reverted_at)fail('This merge has already been reverted.');
 if(audit.recovery_version!==1)fail('This older merge has no complete recovery journal and needs manual recovery.');
 if(!audit.in_window)fail('The 48-hour revert window has expired. No records were changed.');
 return audit;
}

// Inverse replay touches only journaled rows. A post-merge row with a new ID is
// never deleted. UPDATE restores only fields actually changed by the merge,
// preserving later punch-outs or unrelated edits. Ambiguous edits fail closed.
async function replayUndo(client,audit) {
 const previous=(await client.query("SELECT current_setting('matrixtrack.merge_replay',true) AS value")).rows[0]?.value || '';
 await client.query("SELECT set_config('matrixtrack.merge_replay','on',true)");
 const changes=(await client.query('SELECT * FROM workforce_merge_changes WHERE merge_id=$1 ORDER BY id DESC',[audit.id])).rows;
 if(!changes.length)fail('This merge has no recovery journal. No records were changed.');
 const states=[];
 const affected=new Map();
 const metadataCache=new Map();
 for(const change of changes) {
  const table=`${quote(change.table_schema)}.${quote(change.table_name)}`;
  const before=change.before_row,after=change.after_row;
  const reference=after || before;
  const key=change.key_columns.length ? Object.fromEntries(change.key_columns.map(column=>[column,reference[column]])) : reference;
  const predicate=parameter=>change.key_columns.length
   ? change.key_columns.map(column=>`t.${quote(column)}=(jsonb_populate_record(NULL::${table},$${parameter}::jsonb)).${quote(column)}`).join(' AND ')
   : `to_jsonb(t) @> $${parameter}::jsonb`;
  const rows=(await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${predicate(1)} FOR UPDATE`,[JSON.stringify(key)])).rows;
  const current=rows[0]?.row;
  states.push({id:change.id,current:rows.map(row=>row.row)});
  if(rows.length>1)fail(`Cannot safely identify a changed record in ${change.table_name}. No records were restored.`);
  if(!metadataCache.has(table))metadataCache.set(table,(await client.query(`SELECT a.attname AS name,a.attgenerated AS generated,a.attidentity AS identity
   FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[table])).rows);
  const metadata=metadataCache.get(table);
  if(Object.keys(reference).some(column=>!metadata.some(field=>field.name===column)))fail(`The structure of ${change.table_name} changed after this merge. Manual recovery is required.`);
  const columns=metadata.filter(column=>!column.generated).map(column=>column.name);
  if(change.operation==='DELETE') {
   if(current)fail(`An original ID in ${change.table_name} is already in use. Revert stopped without changes.`);
   await client.query(`INSERT INTO ${table} (${columns.map(quote).join(',')}) OVERRIDING SYSTEM VALUE
    SELECT ${columns.map(column=>`r.${quote(column)}`).join(',')} FROM jsonb_populate_record(NULL::${table},$1::jsonb) r`,[JSON.stringify(before)]);
  } else if(change.operation==='INSERT') {
   if(!current || !same(current,after))fail(`A merge-created record in ${change.table_name} changed. Revert stopped to preserve newer data.`);
   await client.query(`DELETE FROM ${table} t WHERE ${predicate(1)}`,[JSON.stringify(key)]);
  } else {
   if(!current)fail(`A moved record in ${change.table_name} is missing. Manual recovery is required.`);
   const changed=columns.filter(column=>!same(before[column],after[column]));
   const restore=changed.filter(column=>column!=='updated_at' || same(current[column],after[column]));
   for(const column of restore)if(!same(current[column],after[column]))fail(`Newer changes to ${change.table_name}.${column} conflict with this revert. No records were changed.`);
   if(restore.length)await client.query(`UPDATE ${table} t SET ${restore.map(column=>`${quote(column)}=r.${quote(column)}`).join(',')}
    FROM jsonb_populate_record(NULL::${table},$1::jsonb) r WHERE ${predicate(2)}`,[JSON.stringify(before),JSON.stringify(key)]);
  }
  affected.set(change.table_name,(affected.get(change.table_name)||0)+1);
 }
 await client.query("SELECT set_config('matrixtrack.merge_replay',$1,true)",[previous]);
 return {fingerprint:fingerprint({auditId:audit.id,changes,states}),affected:[...affected].map(([table,count])=>({table,count}))};
}
async function previewRestore(client,audit) {
 await client.query('SAVEPOINT restore_preview');
 try {
  const result=await replayUndo(client,audit);
  await client.query('ROLLBACK TO SAVEPOINT restore_preview');
  await client.query('RELEASE SAVEPOINT restore_preview');
  return result;
 }catch(error){await client.query('ROLLBACK TO SAVEPOINT restore_preview');throw error;}
}
module.exports={ensureRecoverySchema,recoveryTables,installRecoveryTriggers,assertRecoveryReady,beginRecovery,auditForRestore,replayUndo,previewRestore};
