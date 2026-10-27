const {modeFields,modeJoin}=require('./employeeAttendanceMode');
function regularTeamAttendanceQuery(params){
 const cte=`WITH scoped AS (
  SELECT e.* FROM employee e WHERE EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=e.ward_id)
   AND ($3::int IS NULL OR e.ward_id=$3) AND ($5::text='' OR strpos(lower(COALESCE(e.name,'')||' '||COALESCE(e.emp_code,'')),lower($5))>0)
   AND NOT COALESCE(e.self_attendance_enabled,FALSE) AND NOT EXISTS(SELECT 1 FROM professional_employees p WHERE p.emp_code=e.emp_code)
 ), records AS (
  SELECT 'regular'::text AS employee_kind,e.emp_id::text AS employee_id,e.name AS full_name,e.emp_code,w.ward_id AS site_id,w.ward_name AS site_name,d::date::text AS date,
   to_char(a.punch_in_time,'HH24:MI:SS') AS punch_in,to_char(a.punch_out_time,'HH24:MI:SS') AS punch_out,NULL::numeric AS hours_worked,
   a.register_status,a.register_marked_by_name,a.register_marked_at,${modeFields},
   a.supervisor_in_name,a.supervisor_out_name,
   CASE WHEN a.register_status IS NOT NULL THEN 'register' WHEN a.supervisor_in_by IS NOT NULL OR a.supervisor_out_by IS NOT NULL THEN 'supervisor' ELSE 'punch' END AS attendance_source,
   CASE WHEN a.register_status IS NOT NULL THEN a.register_status
    WHEN a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL THEN 'present'
    WHEN a.leave_type IS NOT NULL THEN 'leave-approved' WHEN d::date>$6::date THEN 'upcoming' ELSE 'absent' END AS status
  FROM scoped e JOIN wards w ON w.ward_id=e.ward_id ${modeJoin}
  CROSS JOIN generate_series($2::date,($2::date+INTERVAL '1 month - 1 day')::date,INTERVAL '1 day') d
  LEFT JOIN attendance a ON a.emp_id=e.emp_id AND a.date=d::date WHERE ($4::date IS NULL OR d::date=$4::date)
 )`;
 return {params,cte,sql:`${cte} SELECT
 (SELECT COALESCE(json_agg(r ORDER BY r.date DESC,r.full_name,r.employee_id),'[]'::json) FROM
  (SELECT * FROM records ORDER BY date DESC,full_name,employee_id LIMIT 50 OFFSET $7) r) AS data,
 (SELECT COUNT(*)::int FROM records) AS total,
 (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM (SELECT status,COUNT(*)::int AS n FROM records GROUP BY status) s) AS summary`};
}
module.exports={regularTeamAttendanceQuery};
