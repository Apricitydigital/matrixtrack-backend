const router=require('express').Router();
const pool=require('../config/db');
const auth=require('../middleware/professionalAuth');
const {capabilities}=require('../utils/professionalPunchCutoff');
const {requestPermission,reviewPermission,markAttendance,today}=require('../utils/registerAttendance');
const {modeFields,modeJoin}=require('../utils/employeeAttendanceMode');
const wrap=handler=>async(req,res)=>{try{await handler(req,res);}catch(e){if(!e.status)console.error('[RegisterAttendance]',e.message);res.status(e.status||500).json({success:false,message:e.status?e.message:'Unable to process Register Attendance.'});}};
router.use(auth);
// Authorization is checked again inside each mutation transaction.
router.get('/',wrap(async(req,res)=>{
 const actor=req.professional.professional_id,caps=await capabilities(pool,actor);
 if(!caps.can_view)return res.status(403).json({success:false,message:'Assigned team designation required.'});
 const date=await today(pool);
 const rows=(await pool.query(`SELECT r.*,r.starts_on::text,r.ends_on::text,e.name,e.emp_code,w.ward_name AS site_name,p.full_name AS requested_by_name,
  CASE WHEN r.status='approved' AND r.ends_on<$2::date THEN 'expired' ELSE r.status END AS display_status,
  hp.full_name AS ho_reviewer_name,dp.full_name AS hod_reviewer_name,
  (($3::boolean AND r.status='pending_ho') OR ($4::boolean AND r.status='pending_hod'))
   AND r.requested_by<>$1 AND r.ho_reviewer_id IS DISTINCT FROM $1
   AND EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=r.site_id) AS can_review
  FROM register_attendance_requests r JOIN employee e ON e.emp_id=r.emp_id JOIN wards w ON w.ward_id=r.site_id
  JOIN professional_employees p ON p.id=r.requested_by
  LEFT JOIN professional_employees hp ON hp.id=r.ho_reviewer_id LEFT JOIN professional_employees dp ON dp.id=r.hod_reviewer_id
  WHERE r.requested_by=$1 OR (($3::boolean OR $4::boolean) AND EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=r.site_id))
  ORDER BY r.created_at DESC LIMIT 500`,[actor,date,caps.ho,caps.hod])).rows;
 const employees=caps.pm?(await pool.query(`SELECT e.emp_id,e.name,e.emp_code,w.ward_name AS site_name,${modeFields},
  r.id AS approval_id,r.ends_on::text,a.register_status,a.punch_in_time IS NOT NULL OR a.punch_out_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL OR a.leave_type IS NOT NULL AS already_marked
  FROM employee e JOIN wards w ON w.ward_id=e.ward_id
  ${modeJoin}
  LEFT JOIN register_attendance_requests r ON r.emp_id=e.emp_id AND r.requested_by=$1 AND r.site_id=e.ward_id
   AND r.status='approved' AND $2::date BETWEEN r.starts_on AND r.ends_on
  LEFT JOIN attendance a ON a.emp_id=e.emp_id AND a.date=$2::date
  WHERE EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=e.ward_id)
   AND COALESCE((to_jsonb(e)->>'is_active')::boolean,TRUE) AND NOT COALESCE((to_jsonb(e)->>'is_deleted')::boolean,FALSE)
   AND NOT COALESCE(e.self_attendance_enabled,FALSE) AND NOT EXISTS(SELECT 1 FROM professional_employees p WHERE p.emp_code=e.emp_code)
  ORDER BY e.name,e.emp_id`,[actor,date])).rows:[];
 res.json({success:true,data:rows,employees,today:date,capabilities:{request:caps.pm,review:caps.ho||caps.hod}});
}));
async function transaction(fn){const client=await pool.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
router.post('/requests',wrap(async(req,res)=>res.status(201).json({success:true,data:await transaction(db=>requestPermission(db,req.professional.professional_id,req.body))})));
router.post('/requests/:id/review',wrap(async(req,res)=>res.json({success:true,data:await transaction(db=>reviewPermission(db,req.professional.professional_id,req.params.id,req.body))})));
router.post('/mark',wrap(async(req,res)=>res.status(201).json({success:true,data:await transaction(db=>markAttendance(db,req.professional.professional_id,req.body))})));
module.exports=router;
