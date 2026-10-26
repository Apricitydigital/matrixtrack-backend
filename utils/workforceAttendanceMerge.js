const {quote}=require('./workforceReview');
const reject=message=>{throw Object.assign(new Error(message),{status:409});};

// Agreeing rows can complete missing facts. Conflicting rows require an explicit
// choice of one complete record; never invent times with MIN/MAX or mix facts.
async function attendanceMergePlan(client,ids,targetId,resolutions={}) {
 if(!resolutions || typeof resolutions!=='object' || Array.isArray(resolutions) || Object.keys(resolutions).length>2000 ||
  Object.entries(resolutions).some(([date,id])=>!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof id!=='string' || !id.length))
  throw Object.assign(new Error('Invalid attendance conflict choices.'),{status:400});
 const rows=(await client.query(`SELECT to_jsonb(a) AS row FROM professional_attendance a
 WHERE professional_id::text=ANY($1::text[]) ORDER BY date,id FOR UPDATE`,[ids])).rows.map(result=>result.row);
 const days=new Map();
 for(const row of rows) {
  if(!days.has(row.date)) days.set(row.date,[]);
  days.get(row.date).push(row);
 }
 const groups=[],conflicts=[],allConflicts=[],conflictDates=new Set();
 for(const [date,records] of days) {
  if(records.length<2) continue;
  if(new Set(records.map(row=>row.professional_id)).size!==records.length) reject(`Multiple attendance sessions exist on ${date}. Review them before merging.`);
  let survivor=records.find(row=>row.professional_id===targetId) || records[0];
  let values={...survivor},updates={};
  const different=new Set();
  for(const row of records) for(const [field,value] of Object.entries(row)) {
   if(['id','professional_id','created_at','updated_at'].includes(field) || value===null) continue;
   if(values[field]!==null && values[field]!==undefined && JSON.stringify(values[field])!==JSON.stringify(value)) different.add(field);
   if(values[field]===null || values[field]===undefined) {values[field]=value;updates[field]=value;}
  }
  if(different.size) {
   conflictDates.add(date);
   const details={date,fields:[...different],records:records.map(row=>({id:String(row.id),professional_id:row.professional_id,
    punch_in:row.punch_in,punch_out:row.punch_out,attempted_punch_in:row.attempted_punch_in,punch_approval_status:row.punch_approval_status,
    differences:Object.fromEntries([...different].map(field=>[field,row[field] ?? null]))}))};
   allConflicts.push(details);
   const chosen=Object.hasOwn(resolutions,date) ? records.find(row=>String(row.id)===resolutions[date]) : null;
   if(Object.hasOwn(resolutions,date) && !chosen) reject(`Attendance choice on ${date} changed or is outside this merge. Review the conflicts again.`);
   if(!chosen) {
    conflicts.push(details);
    continue;
   }
   survivor=chosen;values={...chosen};updates={};
  }
  if(values.punch_in && values.punch_out && Date.parse(values.punch_out)<Date.parse(values.punch_in)) reject(`Invalid punch order on ${date}. Review these punches before merging.`);
  groups.push({date,survivorId:String(survivor.id),removedIds:records.filter(row=>row!==survivor).map(row=>String(row.id)),updates,originals:records,
   ...(different.size ? {resolution:{date,attendanceId:String(survivor.id),professionalId:survivor.professional_id}} : {})});
 }
 if(Object.keys(resolutions).some(date=>!conflictDates.has(date))) reject('Attendance conflicts changed. Clear the previous choices and review this merge again.');
 if(conflicts.length) throw Object.assign(new Error(`Attendance conflict on ${conflicts[0].date}: different ${conflicts[0].fields.map(field=>field.replace(/_/g,' ')).join(', ')}. Choose the correct attendance record for each conflicting date, then check merge safety again. No records were changed.`),{status:409,attendanceConflicts:allConflicts});
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
 return {groups,links,summary:{originalRows:rows.length,uniqueDays:days.size,overlapDays:groups.length,consolidatedRows:groups.reduce((n,group)=>n+group.removedIds.length,0),
  ...(groups.some(group=>group.resolution) ? {resolvedConflicts:groups.filter(group=>group.resolution).map(group=>group.resolution)} : {})}};
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
