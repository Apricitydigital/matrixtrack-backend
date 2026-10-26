const {quote}=require('./workforceReview');
const reject=message=>{throw Object.assign(new Error(message),{status:409});};

// A calendar day may be deduplicated only when all recorded facts agree.
// Missing values can be completed, but different punch times, approval states,
// locations or other non-null facts are never guessed away with MIN/MAX.
async function attendanceMergePlan(client,ids,targetId) {
 const rows=(await client.query(`SELECT to_jsonb(a) AS row FROM professional_attendance a
 WHERE professional_id::text=ANY($1::text[]) ORDER BY date,id FOR UPDATE`,[ids])).rows.map(result=>result.row);
 const days=new Map();
 for(const row of rows) {
  if(!days.has(row.date)) days.set(row.date,[]);
  days.get(row.date).push(row);
 }
 const groups=[];
 for(const [date,records] of days) {
  if(records.length<2) continue;
  if(new Set(records.map(row=>row.professional_id)).size!==records.length) reject(`Multiple attendance sessions exist on ${date}. Review them before merging.`);
  const survivor=records.find(row=>row.professional_id===targetId) || records[0];
  const values={...survivor},updates={};
  for(const row of records) for(const [field,value] of Object.entries(row)) {
   if(['id','professional_id','created_at','updated_at'].includes(field) || value===null) continue;
   if(values[field]!==null && values[field]!==undefined && JSON.stringify(values[field])!==JSON.stringify(value)) reject(`Attendance conflict on ${date}: different ${field.replace(/_/g,' ')}. No records were changed. Correct the conflicting attendance before merging. To discard an incorrect account and its attendance instead, use Delete this duplicate and review the deletion preview.`);
   if(values[field]===null || values[field]===undefined) {values[field]=value;updates[field]=value;}
  }
  if(values.punch_in && values.punch_out && Date.parse(values.punch_out)<Date.parse(values.punch_in)) reject(`Invalid punch order on ${date}. Review these punches before merging.`);
  groups.push({date,survivorId:String(survivor.id),removedIds:records.filter(row=>row!==survivor).map(row=>String(row.id)),updates,originals:records});
 }
 let links=[];
 if(groups.length) {
  links=(await client.query(`SELECT child.relname AS "table",ca.attname AS "column",pa.attname AS parent_column,
   cardinality(f.conkey) AS columns,child_ns.nspname=current_schema() AS local
   FROM pg_constraint f JOIN pg_class parent ON parent.oid=f.confrelid
   JOIN pg_namespace ns ON ns.oid=parent.relnamespace JOIN pg_class child ON child.oid=f.conrelid
   JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
   JOIN pg_attribute ca ON ca.attrelid=f.conrelid AND ca.attnum=f.conkey[1]
   JOIN pg_attribute pa ON pa.attrelid=f.confrelid AND pa.attnum=f.confkey[1]
   WHERE f.contype='f' AND ns.nspname=current_schema() AND parent.relname='professional_attendance'`)).rows;
  if(links.some(link=>!link.local || link.columns!==1 || link.parent_column!=='id' || link.table==='professional_attendance')) reject('Attendance dependencies need manual review before consolidating duplicate dates.');
  const loose=(await client.query(`SELECT c.table_name AS "table",c.column_name AS "column"
   FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
   WHERE c.table_schema=current_schema() AND t.table_type='BASE TABLE' AND c.table_name<>'professional_attendance'
   AND c.data_type=(SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='professional_attendance' AND column_name='id')
   AND (c.column_name='professional_attendance_id' OR (c.column_name='attendance_id' AND c.data_type='uuid'))`)).rows;
  links=[...new Map([...links,...loose].map(link=>[`${link.table}:${link.column}`,{table:link.table,column:link.column}])).values()].sort((a,b)=>`${a.table}:${a.column}`.localeCompare(`${b.table}:${b.column}`));
  const removedIds=groups.flatMap(group=>group.removedIds);
  for(const link of links) link.state=(await client.query(`SELECT count(*)::int AS count,md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM ${quote(link.table)} t WHERE ${quote(link.column)}::text=ANY($1::text[])`,[removedIds])).rows[0];
 }
 return {groups,links,summary:{originalRows:rows.length,uniqueDays:days.size,overlapDays:groups.length,consolidatedRows:groups.reduce((n,group)=>n+group.removedIds.length,0)}};
}
async function consolidateAttendance(client,plan) {
 if(!plan) return;
 for(const group of plan.groups) {
  for(const link of plan.links) await client.query(`UPDATE ${quote(link.table)} SET ${quote(link.column)}=$1 WHERE ${quote(link.column)}::text=ANY($2::text[])`,[group.survivorId,group.removedIds]);
  const entries=Object.entries(group.updates);
  if(entries.length) await client.query(`UPDATE professional_attendance SET ${entries.map(([field],i)=>`${quote(field)}=$${i+2}`).join(',')} WHERE id::text=$1`,[group.survivorId,...entries.map(([,value])=>value)]);
  await client.query('DELETE FROM professional_attendance WHERE id::text=ANY($1::text[])',[group.removedIds]);
 }
}
module.exports={attendanceMergePlan,consolidateAttendance};
