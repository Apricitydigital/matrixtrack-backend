const {quote,fingerprint,deletionPlan}=require('./workforceReview');
const {references}=require('./workforceMerge');
const fail=(message,status=409)=>{throw Object.assign(Error(message),{status});};
const config=kind=>kind==='regular'
 ? {profile:'employee',key:'emp_id',attendance:'attendance',recordKey:'emp_id',id:'attendance_id'}
 : {profile:'self_attendance_employees',key:'id',attendance:'self_attendance_records',recordKey:'self_attendance_id',id:'id'};
const displayTime=value=>value && !/(?:Z|[+-]\d\d:\d\d)$/.test(String(value))?value+'+05:30':value||null;
async function ready(client){
 const result=await client.query(`SELECT to_regclass('workforce_transfer_archive') IS NOT NULL
 AND to_regclass('workforce_cross_attendance_aliases') IS NOT NULL
 AND to_regclass('workforce_separation_audit') IS NOT NULL AS ready`);
 if(!result.rows[0]?.ready)fail('Run the workforce schema upgrade before transferring attendance or keeping accounts separate.',503);
}
async function columns(client,table){
 return (await client.query(`SELECT column_name AS name,column_default,is_nullable,data_type FROM information_schema.columns
 WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,[table])).rows;
}
async function rowsFor(client,table,key,ids){
 return (await client.query(`SELECT to_jsonb(t) AS row FROM ${quote(table)} t WHERE ${quote(key)}::text=ANY($1::text[]) ORDER BY to_jsonb(t)::text FOR UPDATE`,[ids])).rows.map(r=>r.row);
}
// The row keeps its full original payload as well as the permanent archive.
// Punch timestamps are cast in the database with an explicit India timezone.
function mappedRow(row,sourceKind,targetKind,targetId,evidence={}){
 const value={...row};delete value.id;delete value.attendance_id;delete value.emp_id;delete value.self_attendance_id;
 const pairs=[['punch_in_time','punch_in'],['punch_out_time','punch_out'],['latitude_in','punch_in_latitude'],['longitude_in','punch_in_longitude'],
 ['latitude_out','punch_out_latitude'],['longitude_out','punch_out_longitude'],['punch_in_image','punch_in_photo_url'],['punch_out_image','punch_out_photo_url']];
 for(const [regular,self] of pairs){const from=sourceKind==='regular'?regular:self,to=targetKind==='regular'?regular:self;delete value[from];value[to]=row[from]??null;}
 value[config(targetKind).recordKey]=targetId;
 if(sourceKind==='regular' && targetKind==='self_attendance' && !row.punch_in_time && row.mid_shift_punch_in_time){
  // This is the actual first recorded punch, not an invented start time.
  value.punch_in=row.mid_shift_punch_in_time;
  value.punch_in_latitude=row.latitude_mid_in??null;value.punch_in_longitude=row.longitude_mid_in??null;
  value.punch_in_photo_url=row.mid_shift_punch_in_image??null;
 }
 // Self Attendance ward_id can be a retired Sector ID. Only the recorded
 // physical site belongs in regular attendance. Never substitute the posting.
 if(sourceKind==='self_attendance')value.ward_id=row.kothi_id??null;
 value.transfer_original={kind:sourceKind,record:row,evidence};
 return value;
}
async function planTransfer(client,target,sources,resolutions={}){
 await ready(client);
 const reviewedIds=new Set(require('../config/selfAttendanceRecordsIdentities').flatMap(group=>group.profileIds));
 if([target,...sources].some(person=>person.kind==='self_attendance' && reviewedIds.has(person.id)))fail('This profile has reviewed attendance identity links. Reconcile those links before transferring systems.');
 if(!sources.length || sources.some(source=>source.kind===target.kind))fail('Transfer records from one other attendance system at a time. Merge same-type duplicates separately.',400);
 if(!resolutions || typeof resolutions!=='object' || Array.isArray(resolutions) || Object.keys(resolutions).length>2000 || Object.entries(resolutions).some(([date,id])=>!/^\d{4}-\d{2}-\d{2}$/.test(date)||typeof id!=='string'))fail('Invalid attendance choices.',400);
 const destination=config(target.kind),origin=config(sources[0].kind),profiles=[],snapshots=[],deletions=[],links=[];
 for(const person of [target,...sources]){
  const c=config(person.kind),profile=(await rowsFor(client,c.profile,c.key,[person.id]))[0];
  if(!profile)fail('An account changed. Refresh the duplicate review.');
  profiles.push(profile);
  if(person===target){
   if(profile.is_active===false || profile.is_deleted===true)fail('Choose an active main account.');
   if(target.kind==='self_attendance' && !profile.selfie_url)fail('Choose a Self Attendance main account with an enrolled face.');
  }
  const aliases=await client.query(`SELECT 1 FROM workforce_employee_aliases WHERE employee_kind=$1 AND (source_id=$2 OR target_id=$2)
   UNION ALL SELECT 1 FROM workforce_cross_attendance_aliases WHERE (employee_kind=$1 AND source_id=$2) OR (target_kind=$1 AND target_id=$2) LIMIT 1`,[person.kind,person.id]);
  if(aliases.rows.length)fail('This account already has merged identities. Reconcile its existing merge before transferring systems.');
  const pending=await client.query(`SELECT 1 FROM workforce_merge_audit WHERE employee_kind=$1 AND reverted_at IS NULL AND restore_until>clock_timestamp()
   AND (target_id=$2 OR $2=ANY(source_ids)) LIMIT 1`,[person.kind,person.id]);
  if(pending.rows.length)fail('An account has a recoverable merge. Revert it or wait until its recovery window ends.');
 }
 // Only ownership references can move systems. An actor/reviewer reference can
 // belong to another employee's attendance and must never be deleted with this ID.
 const sourceIds=sources.map(p=>p.id);
 const sourceLinks=await references(client,sources[0].kind);
 for(const link of sourceLinks){
  const name='cross_'+require('crypto').createHash('sha256').update(`${sources[0].kind}:${link.table}:${link.column}`).digest('hex').slice(0,24);
  if(!(await client.query(`SELECT 1 FROM pg_trigger WHERE tgname=$1 AND tgrelid=to_regclass($2) AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('workforce_block_cross_attendance_write()')`,[name,quote(link.table)])).rows.length)
   fail('Run the workforce schema upgrade to protect delayed attendance writes before transferring systems.',503);
 }
 for(const link of sourceLinks){
  const rows=await rowsFor(client,link.table,link.column,sourceIds);
  if(!rows.length)continue;
  if([destination.profile,destination.attendance].includes(link.table))fail('The source has a dependency in the destination attendance system. Reconcile that master-account link before transferring; the main account will not be removed.');
  if(!['emp_id','employee_id','self_attendance_id'].includes(link.column))fail(`This account has reviewer or supervisor activity in ${link.table}. Reassign that activity before transferring its attendance.`);
  links.push(link);
 }
 for(const source of sources){
  const deletion=await deletionPlan(client,source.kind,source.id);
  for(const item of deletion){
   if([destination.profile,destination.attendance].includes(item.table))fail('A dependent record belongs to the destination account. Reconcile its master-account link before transferring.');
   const rows=(await client.query(`SELECT to_jsonb(t) AS row FROM ${quote(item.table)} t WHERE ${item.predicate} ORDER BY to_jsonb(t)::text FOR UPDATE`,[source.id])).rows.map(r=>r.row);
   snapshots.push({kind:source.kind,id:source.id,table:item.table,rows});
   links.push({table:item.table,column:origin.key});
  }
  deletions.push({id:source.id,items:deletion});
 }
 // Loose references have no FK and are absent from deletionPlan. Archive them too.
 for(const link of sourceLinks.filter(l=>links.some(item=>item.table===l.table && item.column===l.column))){
  if(snapshots.some(s=>s.table===link.table))continue;
  snapshots.push({kind:sources[0].kind,id:sourceIds.join(','),table:link.table,rows:await rowsFor(client,link.table,link.column,sourceIds)});
 }
 const targetRows=await rowsFor(client,destination.attendance,destination.recordKey,[target.id]);
 snapshots.push({kind:target.kind,id:target.id,table:destination.attendance,rows:targetRows});
 const sourceRows=await rowsFor(client,origin.attendance,origin.recordKey,sourceIds);
 const captureIds=[...new Set(sourceRows.flatMap(row=>[row.supervisor_in_capture,row.supervisor_out_capture]).filter(Boolean))];
 const captures=captureIds.length?(await client.query(`SELECT c.id,c.actor_id,c.image_key,p.full_name AS actor_name FROM supervisor_attendance_captures c
 LEFT JOIN self_attendance_employees p ON p.id=c.actor_id WHERE c.id=ANY($1::uuid[]) ORDER BY c.id FOR SHARE OF c`,[captureIds])).rows:[];
 if(captures.length!==captureIds.length)fail('Supervisor photo evidence is missing. Restore the capture evidence before transferring attendance.');
 const captureById=new Map(captures.map(row=>[row.id,row]));
 const destColumns=await columns(client,destination.attendance);
 if(!destColumns.some(c=>c.name==='transfer_original'))fail('The attendance transfer schema upgrade is required.',503);
 const primary=(await client.query(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
 WHERE i.indrelid=to_regclass($1) AND i.indisprimary`,[destination.attendance])).rows;
 if(primary.length!==1)fail('Attendance primary key needs review before transfer.');
 const targetKey=primary[0].name;
 const sourcePrimary=(await client.query(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
 WHERE i.indrelid=to_regclass($1) AND i.indisprimary`,[origin.attendance])).rows[0]?.name;
 if(!sourcePrimary)fail('Source attendance primary key needs review.');
 const days=new Map();
 for(const [kind,rows,key] of [[target.kind,targetRows,targetKey],[sources[0].kind,sourceRows,sourcePrimary]])for(const row of rows){
  const date=String(row.date).slice(0,10);
  if(!days.has(date))days.set(date,[]);
  days.get(date).push({kind,row,token:`${kind==='regular'?'regular':'self'}:${row[key]}`});
 }
 const conflicts=[],choices=[],conflictDates=new Set();
 for(const [date,records] of days){
  if(!records.some(r=>r.kind!==target.kind))continue;
  let chosen=records[0];
  if(records.length>1){
   conflictDates.add(date);
   const selection=records.find(r=>r.token===resolutions[date]);
   if(resolutions[date] && !selection)fail('An attendance choice changed. Review the merge again.');
   if(!selection){conflicts.push({date,fields:['attendance record'],records:records.map(({row,kind,token})=>({id:token,self_attendance_id:kind==='regular'?String(row.emp_id):row.self_attendance_id,
    punch_in:row.punch_in??displayTime(row.punch_in_time),punch_out:row.punch_out??displayTime(row.punch_out_time),differences:{attendance_system:kind==='regular'?'Supervisor Attendance':'Self Attendance'}}))});continue;}
   chosen=selection;
  }
  const targetRecords=records.filter(r=>r.kind===target.kind);
  if(targetRecords.length>1)fail(`Multiple main-account sessions exist on ${date}. Review them before transferring.`);
  choices.push({date,chosen,targetRecord:targetRecords[0]?.row});
 }
 if(Object.keys(resolutions).some(date=>!conflictDates.has(date)))fail('Attendance conflicts changed. Clear the old choices and check again.');
 if(conflicts.length)throw Object.assign(Error('Choose the attendance record for every common date. All original records will be permanently preserved.'),{status:409,attendanceConflicts:conflicts});
 for(const choice of choices){
  if(choice.chosen.kind===target.kind)continue;
  const row=choice.chosen.row;
  if(target.kind==='regular' && row.kothi_id==null)fail(`Physical site was not recorded for attendance on ${choice.date}. Review and confirm its historical site before transferring. All original records remain unchanged.`);
  choice.evidence={};
  for(const type of ['in','out']){
   const capture=captureById.get(row[`supervisor_${type}_capture`]);
   if(capture)choice.evidence[type]={...capture,actor_name:row[`supervisor_${type}_name`]||capture.actor_name||null};
  }
 }
 // A source leave day cannot be promoted into a worked day. Transfer approved
 // leave separately; unsupported leave types stop the entire transaction.
 const leaves=[];
 if(target.kind==='regular'){
  const sourceLeaves=await rowsFor(client,'self_attendance_leave_requests','self_attendance_id',sourceIds);
  for(const leave of sourceLeaves.filter(l=>l.status==='approved')){
   const date=String(leave.requested_date).slice(0,10);
   if(days.has(date))fail(`Approved leave and attendance both exist on ${date}. Reconcile them before transferring systems.`);
   leaves.push({date,leave_type:leave.leave_type,emp_id:target.id,ward_id:target.site_id,transfer_original:{kind:sources[0].kind,record:leave}});
  }
 }
 const sourceLeaveRows=target.kind==='self_attendance'?choices.filter(c=>c.chosen.kind==='regular' && c.chosen.row.leave_type):[];
 if(target.kind==='self_attendance')for(const choice of choices.filter(c=>c.chosen.kind==='regular' && !c.chosen.row.leave_type)){
  if(!choice.chosen.row.punch_in_time && !choice.chosen.row.mid_shift_punch_in_time && choice.chosen.row.register_status==='present')fail(`Register attendance on ${choice.date} needs review before transfer to Self Attendance. No punch-in will be fabricated.`);
  if((await client.query('SELECT 1 FROM self_attendance_leave_requests WHERE self_attendance_id=$1 AND requested_date=$2 AND status=$3',[target.id,choice.date,'approved'])).rows.length)
   fail(`Approved leave in the main account overlaps attendance on ${choice.date}. Reconcile it before transferring.`);
 }
 const leaveMap={CL:'CASUAL',CASUAL:'CASUAL',ML:'MEDICAL',MEDICAL:'MEDICAL',PL:'PAID',PAID:'PAID'};
 for(const choice of sourceLeaveRows){
  if(choice.targetRecord)fail(`Leave and main-account attendance overlap on ${choice.date}. Reconcile them before transferring systems.`);
  const leaveType=leaveMap[String(choice.chosen.row.leave_type).toUpperCase()];
  if(!leaveType)fail(`Leave type on ${choice.date} needs mapping before transfer. No attendance was changed.`);
  const existing=await client.query('SELECT 1 FROM self_attendance_leave_requests WHERE self_attendance_id=$1 AND requested_date=$2',[target.id,choice.date]);
  if(existing.rows.length)fail(`The main account already has a leave request on ${choice.date}. Reconcile it first.`);
  leaves.push({self_attendance_id:target.id,requested_date:choice.date,leave_type:leaveType,status:'approved',reason:'Transferred with reviewed workforce merge'});
 }
 links.push({table:destination.attendance,column:destination.recordKey},{table:'self_attendance_leave_requests',column:'self_attendance_id'},
  {table:'workforce_transfer_archive',column:'id'},{table:'workforce_cross_attendance_aliases',column:'source_id'});
 const attendance={groups:[],links:[],summary:{originalRows:targetRows.length+sourceRows.length,uniqueDays:days.size,overlapDays:conflictDates.size,originalsPreserved:true}};
 const plan={crossAttendance:true,kind:target.kind,targetId:target.id,sourceIds,profiles,links:[...new Map(links.map(l=>[l.table+':'+l.column,l])).values()],
  affected:snapshots.map(s=>({table:s.table,column:config(s.kind).recordKey,count:s.rows.length})),attendance,
  destination,origin,sources,snapshots,deletions,sourceLinks,choices,leaves,destColumns,targetKey,
  login:{name:target.name,email:profiles[0].email||null,mobile:target.mobile},weeklyOff:null};
 plan.fingerprint=fingerprint({target,sources,profiles,snapshots,choices,leaves,destColumns});
 return plan;
}
function parameter(column,row,index){
 const token=`$${index}`;
 const source=row.transfer_original?.kind;
 if(source==='regular' && column.data_type==='timestamp with time zone' && !/(?:Z|[+-]\d\d:\d\d)$/.test(String(row[column.name]||'')))return `(${token}::timestamp AT TIME ZONE 'Asia/Kolkata')`;
 if(source==='self_attendance' && column.data_type==='timestamp without time zone')return `(${token}::timestamptz AT TIME ZONE 'Asia/Kolkata')`;
 return token;
}
async function insertRow(client,table,row,metadata){
 const fields=metadata||await columns(client,table);
 const names=fields.filter(c=>Object.hasOwn(row,c.name)).map(c=>c.name);
 // Explicit column lists preserve database defaults for IDs and audit timestamps.
 await client.query(`INSERT INTO ${quote(table)} (${names.map(quote).join(',')}) VALUES(${names.map((name,i)=>parameter(fields.find(c=>c.name===name),row,i+1)).join(',')})`,names.map(name=>{
  const value=row[name];return value && typeof value==='object'?JSON.stringify(value):value;
 }));
}
async function applyTransfer(client,plan,audit){
 if(audit)for(const snapshot of plan.snapshots)await client.query(`INSERT INTO workforce_transfer_archive(merge_id,employee_kind,employee_id,source_table,original_rows) VALUES($1,$2,$3,$4,$5)`,
  [audit.id,snapshot.kind,snapshot.id,snapshot.table,JSON.stringify(snapshot.rows)]);
 if(plan.kind==='regular' && Object.hasOwn(plan.profiles[0],'self_attendance_enabled'))
  await client.query('UPDATE employee SET self_attendance_enabled=false WHERE emp_id::text=$1',[plan.targetId]);
 for(const choice of plan.choices){
  if(choice.chosen.kind===plan.kind)continue;
  const row=mappedRow(choice.chosen.row,choice.chosen.kind,plan.kind,plan.targetId,choice.evidence);
  // Leave-only regular rows become approved leave, with their original payload
  // retained in the archive rather than a fabricated self punch-in.
  if(plan.kind==='self_attendance' && !row.punch_in && choice.chosen.row.leave_type)continue;
  if(plan.kind==='self_attendance' && row.ward_id){
   const geo=(await client.query("SELECT COALESCE((to_jsonb(w)->>'sector_id')::int,w.ward_id) AS ward_id,w.ward_id AS kothi_id,z.zone_id,z.city_id FROM wards w JOIN zones z ON z.zone_id=w.zone_id WHERE w.ward_id=$1",[row.ward_id])).rows[0];
   if(geo)Object.assign(row,geo);
  }
  if(choice.targetRecord){
   const names=plan.destColumns.filter(c=>Object.hasOwn(row,c.name)).map(c=>c.name);
   const reset=plan.destColumns.filter(c=>c.name!==plan.targetKey && !Object.hasOwn(row,c.name)).map(c=>`${quote(c.name)}=DEFAULT`);
   await client.query(`UPDATE ${quote(plan.destination.attendance)} SET ${[...names.map((name,i)=>`${quote(name)}=${parameter(plan.destColumns.find(c=>c.name===name),row,i+2)}`),...reset].join(',')} WHERE ${quote(plan.targetKey)}::text=$1`,
    [String(choice.targetRecord[plan.targetKey]),...names.map(name=>row[name]&&typeof row[name]==='object'?JSON.stringify(row[name]):row[name])]);
  }else await insertRow(client,plan.destination.attendance,row,plan.destColumns);
 }
 for(const leave of plan.leaves)await insertRow(client,plan.kind==='regular'?'attendance':'self_attendance_leave_requests',leave);
 // Preserve all evidence before retiring source ownership. Never cascade from a
 // reviewer identity: planTransfer explicitly rejects those dependencies.
 for(const link of plan.sourceLinks)if(!plan.deletions.some(d=>d.items.some(item=>item.table===link.table)))
  await client.query(`DELETE FROM ${quote(link.table)} WHERE ${quote(link.column)}::text=ANY($1::text[])`,[plan.sourceIds]);
 for(const deletion of plan.deletions)for(const item of deletion.items)await client.query(`DELETE FROM ${quote(item.table)} WHERE ${item.predicate}`,[deletion.id]);
 if(plan.kind==='regular' && plan.profiles[0].emp_code && (await client.query('SELECT 1 FROM self_attendance_employees WHERE emp_code=$1 LIMIT 1',[plan.profiles[0].emp_code])).rows.length)
  fail('Another Self Attendance account still uses the main employee code. Review that account too, or give the separate account a unique code first.');
 if(audit)for(const source of plan.sources)await client.query(`INSERT INTO workforce_cross_attendance_aliases(employee_kind,source_id,target_kind,target_id,emp_code,merge_id) VALUES($1,$2,$3,$4,$5,$6)`,
  [source.kind,source.id,plan.kind,plan.targetId,source.emp_code,audit.id]);
}
async function validateTransfer(client,plan){
 await client.query('SAVEPOINT transfer_validation');
 try{await applyTransfer(client,plan);}
 catch(error){await client.query('ROLLBACK TO SAVEPOINT transfer_validation');if(['23502','23503','23505','23514'].includes(error.code))fail('Attendance or dependent settings cannot be represented safely in the selected system. No records were changed. Reconcile the conflicting date, leave or site first.');throw error;}
 await client.query('ROLLBACK TO SAVEPOINT transfer_validation');await client.query('RELEASE SAVEPOINT transfer_validation');
}
module.exports={ready,planTransfer,applyTransfer,validateTransfer};
