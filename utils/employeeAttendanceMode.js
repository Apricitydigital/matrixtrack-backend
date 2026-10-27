// One shared read model for workspace, HR and existing supervisor employee lists.
const modeJoin=`LEFT JOIN supervisor_attendance_faces saf ON saf.emp_id=e.emp_id
 LEFT JOIN LATERAL(SELECT r.status,r.ends_on FROM register_attendance_requests r
  WHERE r.emp_id=e.emp_id AND r.site_id=e.ward_id
   AND (r.status IN ('pending_ho','pending_hod') OR (r.status='approved' AND (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN r.starts_on AND r.ends_on))
  ORDER BY (r.status='approved') DESC,r.created_at DESC LIMIT 1) ram ON TRUE`;
const modeFields=`CASE WHEN COALESCE(e.self_attendance_enabled,FALSE) OR EXISTS(SELECT 1 FROM professional_employees mp WHERE mp.emp_code=e.emp_code) THEN 'professional' WHEN ram.status='approved' THEN 'register' ELSE 'supervisor' END AS attendance_mode,
 ram.status AS register_request_status,ram.ends_on::text AS register_valid_through,
 (e.face_embedding IS NOT NULL OR saf.photo_key IS NOT NULL) AS face_stored,
 (saf.site_id=e.ward_id AND saf.source_ref=e.face_embedding) IS TRUE AS supervisor_face_ready`;
const regularEmployee=`NOT COALESCE(e.self_attendance_enabled,FALSE)
 AND COALESCE((to_jsonb(e)->>'is_active')::boolean,TRUE) AND NOT COALESCE((to_jsonb(e)->>'is_deleted')::boolean,FALSE)
 AND NOT EXISTS(SELECT 1 FROM professional_employees pp WHERE pp.emp_code=e.emp_code)`;
module.exports={modeJoin,modeFields,regularEmployee};
