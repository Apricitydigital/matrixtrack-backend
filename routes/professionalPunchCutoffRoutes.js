const router = require('express').Router();
const pool = require('../config/db');
const auth = require('../middleware/professionalAuth');
const { ensureProfessionalLeaveSchema } = require('../utils/professionalLeaveSchema');
const { ensurePunchCutoffSchema, capabilities, nextDecision, notifyStage } = require('../utils/professionalPunchCutoff');
const wrap = handler => async (req,res) => { try { await handler(req,res); } catch(e) {
  if (!e.status) console.error('[PunchCutoff]',e);
  res.status(e.status || 500).json({success:false,message:e.status ? e.message : 'Unable to process punch-in request.'});
} };
const fail = (message,status=403) => { throw Object.assign(new Error(message),{status}); };
const id = req => req.professional.professional_id;
router.use(auth);
router.use(async(req,res,next)=>{ try {
  await ensurePunchCutoffSchema(); await ensureProfessionalLeaveSchema();
  req.punchCaps=await capabilities(pool,id(req)); next();
} catch(e) { res.status(500).json({success:false,message:'Unable to load punch-in access.'}); } });
router.get('/capabilities',wrap(async(req,res)=>{
  const count=await pool.query(`SELECT COUNT(*)::int AS n FROM professional_attendance a JOIN professional_employees p ON p.id=a.professional_id
    WHERE EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=p.kothi_id)
      AND p.id<>$1 AND ((a.punch_approval_status='pending_pm' AND $2) OR (a.punch_approval_status='pending_ho' AND $3) OR (a.punch_approval_status='pending_hod' AND $4))
      AND NOT EXISTS(SELECT 1 FROM professional_punch_activity l WHERE l.professional_id=p.id AND l.attendance_date=a.date AND l.action='pm_allow' AND l.actor_id=$1)`,[id(req),req.punchCaps.pm,req.punchCaps.ho,req.punchCaps.hod]);
  res.json({success:true,...req.punchCaps,pending_count:count.rows[0].n});
}));
router.use((req,res,next)=>req.punchCaps.can_view ? next() : res.status(403).json({success:false,message:'Assigned team designation required.'}));
router.get('/employees',wrap(async(req,res)=>{
  const {rows}=await pool.query(`SELECT p.id,p.full_name,p.emp_code,w.ward_name AS site_name,c.city_name,t.cutoff_time::text
    FROM professional_employees p LEFT JOIN wards w ON w.ward_id=p.kothi_id LEFT JOIN cities c ON c.city_id=p.city_id
    LEFT JOIN professional_punch_cutoffs t ON t.professional_id=p.id WHERE p.is_active=TRUE
    AND EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=p.kothi_id) ORDER BY p.full_name`,[id(req)]);
  res.json({success:true,data:rows});
}));
router.get('/requests',wrap(async(req,res)=>{
  const bucket=req.query?.bucket || 'all';
  if(!['all','pending','mine','approved','rejected'].includes(bucket)) fail('Choose a valid request status.',400);
  const scoped=`WITH scoped AS (SELECT a.professional_id,a.date::text,a.attempted_punch_in,a.punch_approval_status,a.punch_cutoff::text,
    p.full_name,p.emp_code,w.ward_name AS site_name,
    pm.actor_id AS pm_actor,pm.note AS pm_reason,pm.created_at AS pm_reviewed_at,reviewer.full_name AS pm_reviewer_name,
    ho.note AS ho_reason,ho.created_at AS ho_reviewed_at,ho_reviewer.full_name AS ho_reviewer_name,
    hod.note AS hod_reason,hod.created_at AS hod_reviewed_at,hod_reviewer.full_name AS hod_reviewer_name,
    EXISTS(SELECT 1 FROM professional_punch_activity own WHERE own.professional_id=p.id AND own.attendance_date=a.date
      AND own.actor_id=$1 AND own.action IN ('pm_allow','ho_allow','hod_allow')) AS approved_by_me
    FROM professional_attendance a JOIN professional_employees p ON p.id=a.professional_id LEFT JOIN wards w ON w.ward_id=p.kothi_id
    LEFT JOIN LATERAL(SELECT l.actor_id,l.note,l.created_at FROM professional_punch_activity l
      WHERE l.professional_id=p.id AND l.attendance_date=a.date AND l.action='pm_allow' ORDER BY l.id DESC LIMIT 1) pm ON TRUE
    LEFT JOIN professional_employees reviewer ON reviewer.id=pm.actor_id
    LEFT JOIN LATERAL(SELECT l.actor_id,l.note,l.created_at FROM professional_punch_activity l
      WHERE l.professional_id=p.id AND l.attendance_date=a.date AND l.action='ho_allow' ORDER BY l.id DESC LIMIT 1) ho ON TRUE
    LEFT JOIN professional_employees ho_reviewer ON ho_reviewer.id=ho.actor_id
    LEFT JOIN LATERAL(SELECT l.actor_id,l.note,l.created_at FROM professional_punch_activity l
      WHERE l.professional_id=p.id AND l.attendance_date=a.date AND l.action IN ('hod_allow','hod_reject') ORDER BY l.id DESC LIMIT 1) hod ON TRUE
    LEFT JOIN professional_employees hod_reviewer ON hod_reviewer.id=hod.actor_id
    WHERE a.attempted_punch_in IS NOT NULL AND EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=p.kothi_id))`;
  // Reviewers see their actionable queue; view-only HODs see the team queue.
  const pendingScope=(req.punchCaps.can_manage || req.punchCaps.hod)
    ? "professional_id<>$1 AND (pm_actor IS NULL OR pm_actor<>$1) AND ((punch_approval_status='pending_pm' AND "+(req.punchCaps.pm?'TRUE':'FALSE')+") OR (punch_approval_status='pending_ho' AND "+(req.punchCaps.ho?'TRUE':'FALSE')+") OR (punch_approval_status='pending_hod' AND "+(req.punchCaps.hod?'TRUE':'FALSE')+"))"
    : "punch_approval_status IN ('pending_pm','pending_ho','pending_hod')";
  const counts=(await pool.query(scoped+` SELECT COUNT(*) FILTER(WHERE ${pendingScope})::int AS pending,
    COUNT(*) FILTER(WHERE (${pendingScope}) AND punch_approval_status='pending_pm')::int AS pending_pm,
    COUNT(*) FILTER(WHERE (${pendingScope}) AND punch_approval_status='pending_ho')::int AS pending_ho,
    COUNT(*) FILTER(WHERE (${pendingScope}) AND punch_approval_status='pending_hod')::int AS pending_hod,
    COUNT(*) FILTER(WHERE approved_by_me)::int AS mine,
    COUNT(*) FILTER(WHERE punch_approval_status='accepted')::int AS approved,
    COUNT(*) FILTER(WHERE punch_approval_status='rejected')::int AS rejected FROM scoped`,[id(req)])).rows[0];
  const conditions={all:'TRUE',pending:pendingScope,mine:'approved_by_me',approved:"punch_approval_status='accepted'",rejected:"punch_approval_status='rejected'"};
  const {rows}=await pool.query(scoped+' SELECT *,COUNT(*) OVER(PARTITION BY professional_id)::int AS employee_request_count FROM scoped WHERE '+conditions[bucket]+' ORDER BY date DESC,attempted_punch_in DESC LIMIT 500',[id(req)]);
  res.json({success:true,counts,data:rows.map(r=>({...r,can_review:r.professional_id!==id(req) && r.pm_actor!==id(req) &&
    ((r.punch_approval_status==='pending_hod' && req.punchCaps.hod) || (r.punch_approval_status==='pending_pm' && req.punchCaps.pm) || (r.punch_approval_status==='pending_ho' && req.punchCaps.ho))}))});
}));
router.get('/history',wrap(async(req,res)=>{
  const {rows}=await pool.query(`SELECT l.*,p.full_name,COALESCE(actor.full_name,u.name,'System') AS actor_name FROM professional_punch_activity l
    JOIN professional_employees p ON p.id=l.professional_id LEFT JOIN professional_employees actor ON actor.id=l.actor_id
    LEFT JOIN users u ON u.user_id=l.actor_user_id
    WHERE EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=p.kothi_id) ORDER BY l.id DESC LIMIT 500`,[id(req)]);
  res.json({success:true,data:rows});
}));
async function transaction(req, handler, allowHod=false) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializes scope changes and concurrent cutoff/approval mutations.
    const actor=await client.query('SELECT id FROM professional_employees WHERE id=$1 AND is_active=TRUE FOR UPDATE',[id(req)]);
    if(!actor.rows.length) fail('Account is inactive.');
    const caps=await capabilities(client,id(req));
    if(!caps.can_manage && !(allowHod && caps.hod)) fail('Project Manager or HO Coordinator required.');
    const person=await client.query(`SELECT p.id FROM professional_employees p WHERE p.id=$2 AND p.is_active=TRUE
      AND EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=p.kothi_id) FOR UPDATE OF p`,[id(req),req.params.employee]);
    if(!person.rows.length) fail('Employee is outside your assigned sites.');
    const result=await handler(client,caps);
    await client.query('COMMIT');return result;
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}
router.put('/employees/:employee',wrap(async(req,res)=>{
  const time=String(req.body.cutoff_time || '');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('Use a valid 24-hour time: HH:mm.',400);
  await transaction(req,async client=>{
    const old=await client.query('SELECT cutoff_time FROM professional_punch_cutoffs WHERE professional_id=$1',[req.params.employee]);
    await client.query(`INSERT INTO professional_punch_cutoffs(professional_id,cutoff_time,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(professional_id) DO UPDATE SET cutoff_time=EXCLUDED.cutoff_time,updated_by=EXCLUDED.updated_by,updated_by_user=NULL,updated_at=NOW()`,[req.params.employee,time,id(req)]);
    await client.query(`INSERT INTO professional_punch_activity(professional_id,actor_id,action,old_time,new_time) VALUES($1,$2,'set_time',$3,$4)`,[req.params.employee,id(req),old.rows[0]?.cutoff_time || null,time]);
  }); res.json({success:true,message:'Punch-in cutoff saved (IST).'});
}));
router.post('/requests/:employee/:date',wrap(async(req,res)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) fail('Invalid date.',400);
  const result=await transaction(req,async(client,caps)=>{
    const {rows}=await client.query(`SELECT a.*, (SELECT actor_id FROM professional_punch_activity l WHERE l.professional_id=a.professional_id
      AND l.attendance_date=a.date AND l.action='pm_allow' ORDER BY id DESC LIMIT 1) AS pm_actor
      FROM professional_attendance a WHERE professional_id=$1 AND date=$2 FOR UPDATE`,[req.params.employee,req.params.date]);
    if(!rows.length) fail('Request unavailable.',404);
    const row=rows[0];const status=nextDecision(row.punch_approval_status,caps,req.body.decision,id(req),row.professional_id,row.pm_actor);
    const note=String(req.body.note || '').trim();
    if(note.length>1000) fail('Review reason must be 1000 characters or fewer.',400);
    if(row.punch_approval_status==='pending_pm' && req.body.decision==='allow' && !note) fail('Project Head must enter a reason when approving a late punch-in.',400);
    await client.query(`UPDATE professional_attendance SET punch_approval_status=$3,
      punch_in=CASE WHEN $3='accepted' THEN attempted_punch_in ELSE NULL END WHERE professional_id=$1 AND date=$2`,[row.professional_id,req.params.date,status]);
    const action=(row.punch_approval_status==='pending_hod' ? 'hod_' : row.punch_approval_status==='pending_pm' ? 'pm_' : 'ho_')+req.body.decision;
    await client.query(`INSERT INTO professional_punch_activity(professional_id,attendance_date,actor_id,action,note) VALUES($1,$2,$3,$4,$5)`,[row.professional_id,req.params.date,id(req),action,note]);
    if(status==='pending_ho') await notifyStage(client,row.professional_id,req.params.date,status);
    return {status};
  },true);res.json({success:true,...result});
}));
module.exports=router;
