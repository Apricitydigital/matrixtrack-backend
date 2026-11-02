const pool = require('../config/db');
const { ensureSelfAttendanceLeaveSchema } = require('../utils/selfAttendanceLeaveSchema');
const { capabilities } = require('../utils/selfAttendancePunchCutoff');
const { todayIST } = require('../utils/selfAttendanceWeeklyOff');
const { balances, requireQuota, audit, notify } = require('../utils/selfAttendanceLeaveWorkflow');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const endpoint = handler => async (req, res) => {
  try { await ensureSelfAttendanceLeaveSchema(); await handler(req, res); }
  catch (error) {
    if (!error.status) console.error('[LeaveWorkflow]', error);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Unable to process leave request.' });
  }
};
async function transaction(handler) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await handler(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const requestLeave = endpoint(async (req, res) => {
  const employee = req.self_attendance.self_attendance_id;
  const date = String(req.body.date || req.body.requested_date || '');
  const type = String(req.body.leave_type || req.body.leaveType || '').trim().toUpperCase();
  const reason = String(req.body.reason || '').trim();
  if (!validDate(date) || date < todayIST()) fail('Choose today or a valid future leave date.');
  if (!['MEDICAL', 'CASUAL', 'PAID'].includes(type) || reason.length > 2000) fail('Choose a valid leave type and a reason under 2000 characters.');
  const result = await transaction(async client => {
    const person = await client.query('SELECT id FROM self_attendance_employees WHERE id=$1 AND is_active=TRUE FOR UPDATE', [employee]);
    if (!person.rows.length) fail('Employee is inactive or unavailable.', 403);
    const before = (await client.query('SELECT *,requested_date::text AS requested_date FROM self_attendance_leave_requests WHERE self_attendance_id=$1 AND requested_date=$2 FOR UPDATE', [employee, date])).rows[0];
    if (before?.status === 'approved') fail('Leave is already approved for this date.', 409);
    if (before?.status === 'pending') fail('A request is already awaiting approval for this date.', 409);
    const punched = await client.query('SELECT 1 FROM self_attendance_records WHERE self_attendance_id=$1 AND date=$2 AND (punch_in IS NOT NULL OR attempted_punch_in IS NOT NULL)', [employee, date]);
    if (punched.rows.length) fail('Attendance already exists for this date.', 409);
    if ((await client.query('SELECT self_attendance_is_week_off($1,$2::date) AS off', [employee, date])).rows[0].off) fail('This date is already your assigned Week Off.');
    await requireQuota(client, employee, type, date, before?.id);
    const requesterCaps=await capabilities(client,employee);
    const route=requesterCaps.ho?'hod':'pm_ho';
    const initialStage=requesterCaps.ho?'pending_hod':'pending_pm';
    const values = [employee,date,type,reason || null,initialStage,route];
    const after = before ? (await client.query(`UPDATE self_attendance_leave_requests SET leave_type=$3,reason=$4,status='pending',approval_stage=$5,approval_route=$6,hod_reviewer_id=NULL,hod_reviewed_at=NULL,hod_note=NULL,
      requested_at=NOW(),reviewed_by=NULL,reviewed_at=NULL,review_note=NULL,auto_rejected_at=NULL,pm_reviewer_id=NULL,pm_reviewed_at=NULL,pm_note=NULL,
      ho_reviewer_id=NULL,ho_reviewed_at=NULL,ho_note=NULL WHERE self_attendance_id=$1 AND requested_date=$2 RETURNING *,requested_date::text AS requested_date`, values)).rows[0] :
      (await client.query(`INSERT INTO self_attendance_leave_requests(self_attendance_id,requested_date,leave_type,reason,status,approval_stage,approval_route)
        VALUES($1,$2,$3,$4,'pending',$5,$6) RETURNING *,requested_date::text AS requested_date`, values)).rows[0];
    await audit(client, before, after, employee, reason);
    await notify(client, after);
    return after;
  });
  res.json({ success: true, message: result.approval_route==='hod'?'Leave request sent to Head of Department for approval.':'Leave request sent to Project Head for approval.', data: result });
});

const getBalance = endpoint(async (req, res) => {
  const date = String(req.query.date || todayIST());
  if (!validDate(date)) fail('Choose a valid balance date.');
  const requesterCaps=await capabilities(pool,req.self_attendance.self_attendance_id);
  const all = await balances(pool, req.self_attendance.self_attendance_id, date);
  const byType = {};
  for (const entry of all) if (!byType[entry.leave_type] || entry.remaining < byType[entry.leave_type].remaining) byType[entry.leave_type] = entry;
  const off = await pool.query('SELECT self_attendance_week_off_days_at($1,$2::date) AS days', [req.self_attendance.self_attendance_id,date]);
  res.json({ success: true, data: { approval_route:requesterCaps.ho?'hod':'pm_ho', balance: Object.values(byType), week_off_days: off.rows[0]?.days || [], date } });
});

async function listRequests(req, res, team) {
  const actor = req.self_attendance.self_attendance_id;
  const caps = team ? await capabilities(pool, actor) : null;
  if (team && !caps.can_view) fail('Assigned team designation required.', 403);
  const month = String(req.query.month || '');
  const status = String(req.query.status || '');
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Choose a valid month.');
  if (status && !['pending','approved','rejected'].includes(status)) fail('Choose a valid status.');
  const { rows } = await pool.query(`SELECT l.*,l.requested_date::text AS requested_date,p.full_name,p.emp_code,w.ward_name AS site_name,
    pm.full_name AS pm_reviewer_name,ho.full_name AS ho_reviewer_name,hod.full_name AS hod_reviewer_name,
    COALESCE(hod.full_name,ho.full_name,pm.full_name,u.name) AS reviewed_by_name,
    COALESCE((SELECT json_agg(log ORDER BY log.created_at,log.id) FROM
      (SELECT a.id,a.action,a.note,a.old_values,a.new_values,a.created_at,
        COALESCE(ap.full_name,au.name,a.actor_type) AS actor_name
        FROM self_attendance_leave_request_logs a LEFT JOIN self_attendance_employees ap ON ap.id=a.actor_self_attendance_id
        LEFT JOIN users au ON au.user_id=a.actor_user_id WHERE a.request_id=l.id) log),'[]'::json) AS history
    FROM self_attendance_leave_requests l JOIN self_attendance_employees p ON p.id=l.self_attendance_id
    LEFT JOIN wards w ON w.ward_id=p.kothi_id LEFT JOIN self_attendance_employees pm ON pm.id=l.pm_reviewer_id
    LEFT JOIN self_attendance_employees ho ON ho.id=l.ho_reviewer_id LEFT JOIN self_attendance_employees hod ON hod.id=l.hod_reviewer_id LEFT JOIN users u ON u.user_id=l.reviewed_by
    WHERE ${team ? 'EXISTS(SELECT 1 FROM self_attendance_site_access s WHERE s.self_attendance_id=$1 AND s.kothi_id=p.kothi_id)' : 'l.self_attendance_id=$1'}
      AND ($2::text='' OR to_char(l.requested_date,'YYYY-MM')=$2) AND ($3::text='' OR l.status=$3)
    ORDER BY l.requested_date DESC,l.requested_at DESC LIMIT 500`, [actor, month, status]);
  res.json({ success: true, data: rows.map(r => ({ ...r, can_review: !!(team && r.status === 'pending' && r.self_attendance_id !== actor &&
    ((r.approval_stage === 'pending_hod' && caps.hod) || (r.approval_stage === 'pending_pm' && caps.pm) || (r.approval_stage === 'pending_ho' && caps.ho && r.pm_reviewer_id !== actor))) })), capabilities: caps });
}
const getMyLeaveRequests = endpoint((req,res) => listRequests(req,res,false));
const getTeamRequests = endpoint((req,res) => listRequests(req,res,true));

const review = endpoint(async (req, res) => {
  const actor = req.self_attendance.self_attendance_id;
  const decision = req.body.decision;
  const note = String(req.body.note || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) fail('Invalid request ID.');
  if (!['allow','reject'].includes(decision) || note.length > 2000 || (decision === 'reject' && !note)) fail('Choose allow/reject and provide a reason for rejection.');
  const after = await transaction(async client => {
    const scoped = await client.query(`SELECT p.id FROM self_attendance_leave_requests l JOIN self_attendance_employees p ON p.id=l.self_attendance_id
      WHERE l.id=$1 AND EXISTS(SELECT 1 FROM self_attendance_site_access s WHERE s.self_attendance_id=$2 AND s.kothi_id=p.kothi_id) FOR UPDATE OF p`, [req.params.id,actor]);
    if (!scoped.rows.length) fail('Request unavailable in your assigned sites.', 403);
    const before = (await client.query('SELECT *,requested_date::text AS requested_date FROM self_attendance_leave_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    const caps = await capabilities(client, actor);
    if (before.self_attendance_id === actor) fail('You cannot review your own leave.', 403);
    if (before.status !== 'pending') fail('This request has already been reviewed.', 409);
    if (before.requested_date < todayIST()) fail('The leave date has passed. This request can no longer be approved.', 409);
    const pm = before.approval_stage === 'pending_pm';
    const hod=before.approval_stage==='pending_hod';
    if (!(hod ? caps.hod : pm ? caps.pm : before.approval_stage === 'pending_ho' && caps.ho && before.pm_reviewer_id !== actor)) fail('You cannot review at this approval stage. PM and HO must be different people.', 403);
    if (decision === 'allow') {
      await requireQuota(client, before.self_attendance_id, before.leave_type, before.requested_date, before.id);
      const punched = await client.query('SELECT 1 FROM self_attendance_records WHERE self_attendance_id=$1 AND date=$2 AND (punch_in IS NOT NULL OR attempted_punch_in IS NOT NULL)', [before.self_attendance_id,before.requested_date]);
      if (punched.rows.length) fail('Attendance now exists for this date. Review and reject the leave request instead.', 409);
      if ((await client.query('SELECT self_attendance_is_week_off($1,$2::date) AS off',[before.self_attendance_id,before.requested_date])).rows[0].off) fail('This date is now an assigned Week Off. Reject the leave request to release its reserved balance.', 409);
    }
    const status = decision === 'reject' ? 'rejected' : pm ? 'pending' : 'approved';
    const stage = decision === 'reject' ? 'rejected' : pm ? 'pending_ho' : 'accepted';
    const prefix = hod ? 'hod' : pm ? 'pm' : 'ho';
    const row = (await client.query(`UPDATE self_attendance_leave_requests SET status=$2,approval_stage=$3,
      ${prefix}_reviewer_id=$4,${prefix}_reviewed_at=NOW(),${prefix}_note=$5,reviewed_at=NOW(),review_note=$5
      WHERE id=$1 RETURNING *,requested_date::text AS requested_date`, [before.id,status,stage,actor,note || null])).rows[0];
    await audit(client,before,row,actor,note);
    await notify(client,row);
    return row;
  });
  res.json({ success: true, data: after });
});
module.exports = { requestLeave, getMyLeaveRequests, getBalance, getTeamRequests, review };
