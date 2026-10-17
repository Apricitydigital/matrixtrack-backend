const { PM_ROLES } = require('./professionalPunchCutoff');
function periodBounds(period, date) {
  const [year, month] = date.split('-').map(Number);
  const size = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 }[period];
  if (!size) throw new Error('Invalid allocation period');
  const startMonth = Math.floor((month - 1) / size) * size;
  return [new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10),
    new Date(Date.UTC(year, startMonth + size, 1)).toISOString().slice(0, 10)];
}
async function balances(client, employee, date, exclude = null) {
  const { rows } = await client.query('SELECT leave_type,period,allocated_count FROM professional_leave_allocations WHERE professional_id=$1', [employee]);
  const result = [];
  for (const alloc of rows) {
    const [start, end] = periodBounds(alloc.period, date);
    const usage = (await client.query(`SELECT COUNT(*) FILTER(WHERE status='approved')::int AS used,
      COUNT(*) FILTER(WHERE status='pending')::int AS reserved FROM professional_leave_requests
      WHERE professional_id=$1 AND leave_type=$2 AND requested_date >= $3::date AND requested_date < $4::date
      AND ($5::uuid IS NULL OR id<>$5)`, [employee, alloc.leave_type, start, end, exclude])).rows[0];
    result.push({ leave_type: alloc.leave_type, period: alloc.period, allocated: alloc.allocated_count,
      used: usage.used, reserved: usage.reserved, remaining: Math.max(0, alloc.allocated_count - usage.used - usage.reserved), start, end });
  }
  return result;
}
async function requireQuota(client, employee, type, date, exclude) {
  const entries = (await balances(client, employee, date, exclude)).filter(b => b.leave_type === type);
  if (!entries.length) throw Object.assign(new Error('No leave allocation is configured for this leave type. Contact your administrator.'), { status: 400 });
  if (entries.some(b => b.remaining < 1)) throw Object.assign(new Error('No remaining leave balance for this period. Pending requests also reserve balance.'), { status: 400 });
}
async function audit(client, before, after, actor, note) {
  await client.query(`INSERT INTO professional_leave_request_logs(request_id,action,actor_type,actor_professional_id,note,old_values,new_values)
    VALUES($1,$2,'professional',$3,$4,$5::jsonb,$6::jsonb)`, [after.id,
    !before ? 'submitted' : after.status === 'rejected' ? 'rejected' : after.pm_reviewer_id || after.ho_reviewer_id || after.hod_reviewer_id ? 'approved' : 'resubmitted',
    actor, note || null, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
}
async function notify(client, request) {
  const roles = request.approval_stage === 'pending_hod' ? ['Head of Department'] : request.approval_stage === 'pending_pm' ? PM_ROLES : ['HO Coordinator'];
  if (request.status === 'pending') {
    await client.query(`INSERT INTO professional_notifications(professional_id,type,title,message,metadata)
      SELECT DISTINCT reviewer.id,'leave-request','Leave request awaiting review',p.full_name || ' has requested leave for ' || $2::text,
        jsonb_build_object('request_id',$3::text,'stage',$4::text)
      FROM professional_employees p JOIN professional_site_access s ON s.kothi_id=p.kothi_id
      JOIN professional_employees reviewer ON reviewer.id=s.professional_id AND reviewer.is_active=TRUE
      JOIN professional_designation_assignments a ON a.professional_id=reviewer.id
      JOIN designation d ON d.designation_id=a.designation_id
      WHERE p.id=$1 AND reviewer.id<>p.id AND ($5::uuid IS NULL OR reviewer.id<>$5) AND d.designation_name=ANY($6::text[])`,
    [request.professional_id, String(request.requested_date).slice(0,10), request.id, request.approval_stage, request.pm_reviewer_id, roles]);
  }
  await client.query(`INSERT INTO professional_notifications(professional_id,type,title,message,metadata)
    VALUES($1,'leave-review','Leave request update',$2,jsonb_build_object('request_id',$3::text,'stage',$4::text))`,
  [request.professional_id, request.status === 'pending' ? (request.approval_stage === 'pending_hod' ? 'Leave request sent to Head of Department for final approval.' : request.approval_stage === 'pending_ho' ? 'Project Head approved. Awaiting HO Coordinator.' : 'Leave request sent to Project Head.') : `Leave ${request.status}.`, request.id, request.approval_stage]);
}
module.exports = { periodBounds, balances, requireQuota, audit, notify };
