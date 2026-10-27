const router = require('express').Router();
const pool = require('../config/db');
const auth = require('../middleware/professionalAuth');
const { ensurePunchCutoffSchema, capabilities } = require('../utils/professionalPunchCutoff');
const { ensureProfessionalLeaveSchema } = require('../utils/professionalLeaveSchema');
const { todayIST } = require('../utils/professionalWeeklyOff');
const wrap = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) {
    console.error('[TeamAttendance]', error);
    res.status(500).json({ success: false, message: 'Unable to load team attendance.' });
  }
};
router.use(auth);
router.use(async (req, res, next) => {
  try {
    await ensurePunchCutoffSchema();
    await ensureProfessionalLeaveSchema();
    const access = await capabilities(pool, req.professional.professional_id);
    if (!access.can_view) return res.status(403).json({ success: false, message: 'Assigned team designation required.' });
    next();
  } catch (error) {
    console.error('[TeamAttendance access]', error);
    res.status(500).json({ success: false, message: 'Unable to validate attendance access.' });
  }
});
router.get('/sites', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT DISTINCT w.ward_id AS id,w.ward_name AS name
    FROM professional_site_access s JOIN wards w ON w.ward_id=s.kothi_id
    WHERE s.professional_id=$1 ORDER BY w.ward_name,w.ward_id`, [req.professional.professional_id]);
  res.json({ success: true, data: rows });
}));

router.get('/', wrap(async (req, res) => {
  const employeeType=req.query.employeeType||'all';
  if(!['all','regular','professional'].includes(employeeType))return res.status(400).json({success:false,message:'Choose an employee type.'});
  const today = todayIST();
  const month = req.query.month || today.slice(0, 7);
  const site = req.query.site || '';
  const day = req.query.date || '';
  const search = String(req.query.search || '').trim();
  const page = Number(req.query.page || 1);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '1900-01' || month > today.slice(0, 7) ||
      (site && (!/^\d+$/.test(site) || !Number.isSafeInteger(Number(site)) || Number(site) < 1 || Number(site) > 2147483647)) ||
      !Number.isSafeInteger(page) || page < 1 || page > 100000 || search.length > 100 ||
      (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !day.startsWith(month + '-') ||
        !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day))) {
    return res.status(400).json({ success: false, message: 'Choose a valid month, date, site and page.' });
  }
  if (site) {
    const allowed = await pool.query('SELECT 1 FROM professional_site_access WHERE professional_id=$1 AND kothi_id=$2', [req.professional.professional_id, site]);
    if (!allowed.rows.length) return res.status(403).json({ success: false, message: 'Site outside your assigned access.' });
  }
  const start = `${month}-01`;
  if(employeeType==='regular'){
    const query=require('../utils/regularTeamAttendance').regularTeamAttendanceQuery([req.professional.professional_id,start,site||null,day||null,search,today,(page-1)*50]);
    const result=await pool.query(query.sql,query.params);
    return res.json({success:true,...result.rows[0],page,page_size:50,month});
  }
  // Every employee/date pair is included, so missing punches remain visible.
  // Identity matching by phone/email is deliberately avoided: it could cross site boundaries.
  const cte = `WITH scoped AS (
    SELECT p.* FROM professional_employees p
    WHERE EXISTS(SELECT 1 FROM professional_site_access s WHERE s.professional_id=$1 AND s.kothi_id=p.kothi_id)
      AND ($3::int IS NULL OR p.kothi_id=$3)
      AND ($5::text='' OR strpos(lower(COALESCE(p.full_name,'') || ' ' || COALESCE(p.emp_code,'')),lower($5))>0)
      AND (p.is_active=TRUE OR EXISTS(SELECT 1 FROM professional_attendance a WHERE a.professional_id=p.id
        AND a.date >= $2::date AND a.date < $2::date + INTERVAL '1 month'))
  ), records AS (
    SELECT 'professional'::text AS employee_kind,p.id AS employee_id,p.full_name,p.emp_code,p.kothi_id AS site_id,w.ward_name AS site_name,
      d::date::text AS date,a.punch_in,a.punch_out,a.attempted_punch_in,a.punch_approval_status,
      CASE WHEN a.punch_in IS NOT NULL AND a.punch_out IS NOT NULL
        THEN ROUND((EXTRACT(EPOCH FROM (a.punch_out-a.punch_in))/3600)::numeric,2) END AS hours_worked,
      CASE WHEN a.punch_approval_status='rejected' THEN 'punch-not-accepted'
        WHEN a.punch_approval_status IN ('pending_pm','pending_ho','pending_hod') THEN 'in-consideration'
        WHEN a.punch_in IS NOT NULL THEN CASE WHEN a.punch_out IS NOT NULL AND a.punch_out-a.punch_in < INTERVAL '4 hours' THEN 'half-day' ELSE 'present' END
        WHEN EXISTS(SELECT 1 FROM professional_holidays h WHERE h.holiday_date=d::date AND h.city_id=p.city_id
          AND (h.zone_id IS NULL OR h.zone_id=p.zone_id) AND (h.ward_id IS NULL OR h.ward_id=p.ward_id)
          AND (h.kothi_id IS NULL OR h.kothi_id=p.kothi_id)) THEN 'holiday'
        WHEN EXISTS(SELECT 1 FROM professional_leave_requests l WHERE l.professional_id=p.id AND l.requested_date=d::date AND l.status='approved') THEN 'leave-approved'
        WHEN EXISTS(SELECT 1 FROM professional_leave_requests l WHERE l.professional_id=p.id AND l.requested_date=d::date AND l.status='pending') THEN 'leave-pending'
        WHEN EXISTS(SELECT 1 FROM professional_leave_requests l WHERE l.professional_id=p.id AND l.requested_date=d::date AND l.status='rejected') THEN 'leave-rejected'
        WHEN professional_is_week_off(p.id,d::date) THEN 'weekly-off'
        WHEN d::date>$6::date THEN 'upcoming'
        ELSE 'absent' END AS status
    FROM scoped p LEFT JOIN wards w ON w.ward_id=p.kothi_id
    CROSS JOIN generate_series($2::date,($2::date+INTERVAL '1 month - 1 day')::date,INTERVAL '1 day') d
    LEFT JOIN professional_attendance a ON a.professional_id=p.id AND a.date=d::date
    WHERE ($4::date IS NULL OR d::date=$4::date)
  )`;
  const params = [req.professional.professional_id,start,site || null,day || null,search,today];
  if(employeeType==='all'){
    const regular=require('../utils/regularTeamAttendance').regularTeamAttendanceQuery([...params,(page-1)*50]);
    const query=require('../utils/combinedTeamAttendance').combinedTeamAttendanceQuery(cte,regular.cte,[...params,(page-1)*50]);
    const result=await pool.query(query.sql,query.params);
    return res.json({success:true,...result.rows[0],page,page_size:50,month});
  }
  const result = await pool.query(`${cte} SELECT
    (SELECT COALESCE(json_agg(r ORDER BY (r.date>$6::text),r.date DESC,r.full_name,r.employee_id),'[]'::json) FROM
      (SELECT * FROM records ORDER BY (date>$6::text),date DESC,full_name,employee_id LIMIT 50 OFFSET $7) r) AS data,
    (SELECT COUNT(*)::int FROM records) AS total,
    (SELECT COALESCE(json_object_agg(status,n),'{}'::json) FROM
      (SELECT status,COUNT(*)::int AS n FROM records GROUP BY status) s) AS summary`, [...params,(page-1)*50]);
  res.json({ success: true, ...result.rows[0], page, page_size: 50, month });
}));
module.exports = router;
