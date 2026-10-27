const {capabilities}=require('./professionalPunchCutoff');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const today=async db=>(await db.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS today")).rows[0].today;
async function access(db,actor,site,role){
 const caps=await capabilities(db,actor);
 if(!caps[role])fail(role==='pm'?'Project Head access required.':'You cannot review at this stage.',403);
 if(!(await db.query('SELECT 1 FROM professional_site_access s JOIN professional_employees p ON p.id=s.professional_id AND p.is_active=TRUE WHERE s.professional_id=$1 AND s.kothi_id=$2',[actor,site])).rows.length)fail('Employee is outside your assigned sites or your access is inactive.',403);
}
async function employee(db,id,lock=false){
 if(!/^[1-9]\d*$/.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)>2147483647)fail('Select an employee.');
 const row=(await db.query(`SELECT e.* FROM employee e WHERE e.emp_id=$1 ${lock?'FOR UPDATE OF e':''}`,[id])).rows[0];
 if(!row||row.is_active===false||row.is_deleted===true||row.self_attendance_enabled===true)fail('Regular employee is unavailable.',409);
 if((await db.query('SELECT 1 FROM professional_employees WHERE emp_code=$1 LIMIT 1',[row.emp_code])).rows.length)fail('Choose a regular employee.',409);
 return row;
}
async function audit(db,before,after,actor,action){
 await db.query('INSERT INTO register_attendance_audit(request_id,actor_id,action,before_record,after_record) VALUES($1,$2,$3,$4,$5)',[after.id,actor,action,before?JSON.stringify(before):null,JSON.stringify(after)]);
}
async function notify(db,row){
 const pending=row.status==='pending_ho'||row.status==='pending_hod';
 const role=row.status==='pending_ho'?'HO Coordinator':'Head of Department';
 if(!pending){
  await db.query(`INSERT INTO professional_notifications(professional_id,type,title,message,metadata) VALUES($1,'register-attendance',$2,$3,jsonb_build_object('request_id',$4::text,'kind','register-attendance'))`,[row.requested_by,`Register Attendance ${row.status}`,`Your request was ${row.status}.`,row.id]);return;
 }
 await db.query(`INSERT INTO professional_notifications(professional_id,type,title,message,metadata)
  SELECT DISTINCT p.id,'register-attendance',$3,$4,jsonb_build_object('request_id',$1::text,'kind','register-attendance')
  FROM professional_employees p WHERE p.is_active=TRUE AND p.id<>$5::uuid AND p.id IS DISTINCT FROM $6::uuid
    AND EXISTS(SELECT 1 FROM professional_designation_assignments a JOIN designation d ON d.designation_id=a.designation_id WHERE a.professional_id=p.id AND d.designation_name=$7)
    AND EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=p.id AND s.kothi_id=$2)`,
 [row.id,row.site_id,pending?'Register Attendance request':`Register Attendance ${row.status}`,pending?'An employee request needs your review.':`Your request was ${row.status}.`,row.requested_by,row.ho_reviewer_id||null,role]);
}
async function requestPermission(db,actor,body){
 const days=body.duration_days===undefined?30:body.duration_days,reason=String(body.reason||'').trim();
 if(!Number.isInteger(days)||days<1||days>30||reason.length<3||reason.length>1000)fail('Choose 1–30 days and enter a reason.');
 const e=await employee(db,body.emp_id,true);await access(db,actor,e.ward_id,'pm');
 const date=await today(db);
 if((await db.query("SELECT 1 FROM register_attendance_requests WHERE emp_id=$1 AND (status IN ('pending_ho','pending_hod') OR (status='approved' AND ends_on >= $2::date))",[e.emp_id,date])).rows.length)fail('An active or pending request already exists.',409);
 const reviewers=(await db.query(`SELECT DISTINCT d.designation_name,p.id FROM professional_employees p
  JOIN professional_designation_assignments a ON a.professional_id=p.id JOIN designation d ON d.designation_id=a.designation_id
  JOIN professional_site_access s ON s.professional_id=p.id AND s.kothi_id=$2
  WHERE p.is_active=TRUE AND p.id<>$1 AND d.designation_name IN ('HO Coordinator','Head of Department')`,[actor,e.ward_id])).rows;
 if(!reviewers.some(a=>a.designation_name==='HO Coordinator'&&reviewers.some(b=>b.designation_name==='Head of Department'&&b.id!==a.id)))fail('Assign different HO and HOD reviewers for this site.',409);
 const row=(await db.query('INSERT INTO register_attendance_requests(emp_id,site_id,requested_by,duration_days,reason) VALUES($1,$2,$3,$4,$5) RETURNING *',[e.emp_id,e.ward_id,actor,days,reason])).rows[0];
 await audit(db,null,row,actor,'requested');await notify(db,row);return row;
}
async function reviewPermission(db,actor,id,body){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))fail('Invalid request.');
 const note=String(body.note||'').trim();
 if(!['approve','reject'].includes(body.decision)||note.length>1000||(body.decision==='reject'&&note.length<3))fail('Choose a decision and enter a rejection reason.');
 // Lock employee before request, matching creation/marking lock order.
 const found=(await db.query('SELECT emp_id FROM register_attendance_requests WHERE id=$1',[id])).rows[0];
 if(!found)fail('Request not found.',404);
 const e=await employee(db,found.emp_id,true);
 const before=(await db.query('SELECT * FROM register_attendance_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!['pending_ho','pending_hod'].includes(before.status))fail('This request has already been reviewed.',409);
 if(before.site_id!==e.ward_id)fail('Employee site changed. Submit a new request.',409);
 if(actor===before.requested_by||actor===before.ho_reviewer_id)fail('Each approval must be by a different reviewer.',403);
 const ho=before.status==='pending_ho';await access(db,actor,before.site_id,ho?'ho':'hod');
 await access(db,before.requested_by,before.site_id,'pm');
 if(!(await db.query('SELECT 1 FROM professional_employees WHERE id=$1 AND is_active=TRUE',[before.requested_by])).rows.length)fail('Requesting supervisor is inactive.',409);
 const status=body.decision==='reject'?'rejected':ho?'pending_hod':'approved',prefix=ho?'ho':'hod';
 const date=await today(db);
 const row=(await db.query(`UPDATE register_attendance_requests SET status=$2,${prefix}_reviewer_id=$3,${prefix}_reviewed_at=clock_timestamp(),${prefix}_note=$4,
  starts_on=CASE WHEN $2='approved' THEN $5::date ELSE starts_on END,
  ends_on=CASE WHEN $2='approved' THEN $5::date+duration_days-1 ELSE ends_on END WHERE id=$1 RETURNING *`,[id,status,actor,note||null,date])).rows[0];
 await audit(db,before,row,actor,`${prefix}_${body.decision}`);await notify(db,row);return row;
}
async function markAttendance(db,actor,body){
 if(!['present','absent'].includes(body.status))fail('Choose Present or Absent.');
 const date=await today(db);if(body.date&&body.date!==date)fail('Only today’s attendance can be marked.');
 const e=await employee(db,body.emp_id,true);await access(db,actor,e.ward_id,'pm');
 const request=(await db.query(`SELECT * FROM register_attendance_requests WHERE emp_id=$1 AND requested_by=$2 AND site_id=$3
  AND status='approved' AND starts_on <= $4::date AND ends_on >= $4::date FOR UPDATE`,[e.emp_id,actor,e.ward_id,date])).rows[0];
 if(!request)fail('No active Register Attendance approval for this employee.',403);
 if((await db.query(`SELECT 1 FROM attendance WHERE emp_id=$1 AND date=$2::date AND
  (punch_in_time IS NOT NULL OR punch_out_time IS NOT NULL OR mid_shift_punch_in_time IS NOT NULL OR leave_type IS NOT NULL OR register_status IS NOT NULL)`,[e.emp_id,date])).rows.length)fail('Attendance is already marked for today.',409);
 const actorName=(await db.query('SELECT full_name FROM professional_employees WHERE id=$1',[actor])).rows[0]?.full_name;
 const result=await db.query(`INSERT INTO attendance(emp_id,date,ward_id,register_status,register_request_id,register_marked_by,register_marked_at,register_marked_by_name)
  VALUES($1,$2::date,$3,$4,$5,$6,clock_timestamp(),$7)
  ON CONFLICT(emp_id,date) DO UPDATE SET ward_id=EXCLUDED.ward_id,register_status=EXCLUDED.register_status,
   register_request_id=EXCLUDED.register_request_id,register_marked_by=EXCLUDED.register_marked_by,register_marked_at=EXCLUDED.register_marked_at,register_marked_by_name=EXCLUDED.register_marked_by_name
  WHERE attendance.punch_in_time IS NULL AND attendance.punch_out_time IS NULL AND attendance.mid_shift_punch_in_time IS NULL AND attendance.leave_type IS NULL AND attendance.register_status IS NULL
  RETURNING *`,[e.emp_id,date,e.ward_id,body.status,request.id,actor,actorName]);
 if(!result.rows.length)fail('Attendance was just marked. Refresh the list.',409);
 await audit(db,null,{...request,attendance:result.rows[0]},actor,`marked_${body.status}`);return result.rows[0];
}
module.exports={requestPermission,reviewPermission,markAttendance,today};
