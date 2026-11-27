const {attendanceSourceIds}=require('./selfAttendanceRecordsIdentity');

// Read current punch-access status without installing schema, filtering out an
// employee or changing their historical attendance status.
async function workforceBlockDetails(client,profiles){
 const result=profiles.map(row=>({...row,is_attendance_blocked:false,attendance_blocked_at:null,attendance_block_reason:null}));
 const ids=[...new Set(profiles.filter(row=>row.kind==='self_attendance').flatMap(row=>attendanceSourceIds(row.id)))];
 if(!ids.length || !(await client.query("SELECT to_regclass('self_attendance_records_blocks') IS NOT NULL AS available")).rows[0]?.available)return result;
 const blocks=(await client.query(`SELECT self_attendance_id,reason,updated_at FROM self_attendance_records_blocks
 WHERE self_attendance_id=ANY($1::uuid[]) AND is_blocked=TRUE ORDER BY updated_at DESC,self_attendance_id`,[ids])).rows;
 const byId=new Map();
 for(const block of blocks)for(const id of attendanceSourceIds(block.self_attendance_id))if(!byId.has(id))byId.set(id,block);
 return result.map(row=>{
  const block=row.kind==='self_attendance'?byId.get(row.id):null;
  return block?{...row,is_attendance_blocked:true,attendance_blocked_at:block.updated_at,attendance_block_reason:block.reason}:row;
 });
}
module.exports={workforceBlockDetails};
