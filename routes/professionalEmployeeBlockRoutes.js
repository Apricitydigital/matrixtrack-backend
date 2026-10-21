const router = require('express').Router();
const pool = require('../config/db');
const authenticate = require('../middleware/authMiddleware');
const { attachCityScope } = require('../middleware/cityScope');
const { authorize, getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { attendanceSourceIds } = require('../utils/professionalAttendanceIdentity');
const { ensureAttendanceBlockSchema, lockAttendanceProfiles, withAttendanceBlocks } = require('../utils/professionalAttendanceBlock');
const moduleName = 'professional-employee-block';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const wrap = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) {
    if (!error.status) console.error('[EmployeeBlock]', error);
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Unable to manage employee attendance access.' });
  }
};

router.use(authenticate);
router.use(async (req, res, next) => {
  try {
    const id = req.user?.user_id || req.user?.id || req.user?.userId;
    const user = (await pool.query('SELECT user_id,name,email,role,permissions,is_deleted FROM users WHERE user_id=$1', [id])).rows[0];
    let permissions = user?.permissions;
    if (typeof permissions === 'string') permissions = JSON.parse(permissions);
    if (!user || user.is_deleted || !['admin','super_admin'].includes(user.role) || permissions?.is_active === false)
      return res.status(403).json({ success: false, message: 'Active admin account required.' });
    const owners = [process.env.SUPER_ADMIN_EMAIL || 'mtadmin@apricitydigital.in', process.env.SUPER_ADMIN_DB_EMAIL || 'admin@gmail.com'];
    req.blockOwner = user.role === 'super_admin' || permissions?.role_type === 'super_admin' ||
      owners.some(email => email.trim().toLowerCase() === String(user.email || '').trim().toLowerCase());
    req.blockActor = user;
    req.user = { ...req.user, user_id: user.user_id, role: 'admin', permissions };
    next();
  } catch (error) { res.status(503).json({ success: false, message: 'Unable to validate admin access.' }); }
});
router.use(attachCityScope);
const permission = action => (req, res, next) => {
  req.blockAction = action;
  return req.blockOwner ? next() : authorize(moduleName, action)(req, res, next);
};
const scope = req => getPermissionCityFilter(req, moduleName, req.blockAction);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateId(req) {
  if (!uuid.test(req.params.id || '')) fail('Invalid employee ID.');
  return req.params.id.toLowerCase();
}
async function visibleEmployee(req, id, client = pool) {
  const employee = (await client.query(`SELECT id,full_name,emp_code,mobile,city_id FROM professional_employees
    WHERE id=$1 AND ($2::int[] IS NULL OR city_id=ANY($2))`, [id, scope(req)])).rows[0];
  if (!employee) fail('Employee not found or outside your assigned access.', 404);
  return employee;
}

router.get('/', permission('view'), wrap(async (req, res) => {
  await ensureAttendanceBlockSchema();
  const q = String(req.query.search || '').trim().slice(0, 160);
  const state = req.query.status || 'all';
  if (!['all','blocked','allowed'].includes(state)) fail('Invalid attendance access filter.');
  const page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
  const limit = 25;
  // Search by stable employee details. Do not deduplicate people by name/mobile.
  const result = await pool.query(`SELECT p.id,p.full_name,p.emp_code,p.mobile,p.is_active,p.city_id,
    c.city_name,z.zone_name,w.ward_name AS site_name
    FROM professional_employees p LEFT JOIN cities c ON c.city_id=p.city_id
    LEFT JOIN zones z ON z.zone_id=p.zone_id LEFT JOIN wards w ON w.ward_id=p.kothi_id
    WHERE ($1::int[] IS NULL OR p.city_id=ANY($1)) AND
      ($2='' OR p.full_name ILIKE '%' || $2 || '%' OR p.emp_code ILIKE '%' || $2 || '%' OR p.mobile ILIKE '%' || $2 || '%')
    ORDER BY p.full_name,p.id`, [scope(req), q]);
  const enriched = await withAttendanceBlocks(result.rows);
  const filtered = enriched.filter(p => state === 'all' || (state === 'blocked') === !!p.is_attendance_blocked);
  res.json({ success: true, data: filtered.slice((page - 1) * limit, page * limit),
    pagination: { page, limit, total: filtered.length, pages: Math.max(1, Math.ceil(filtered.length / limit)) } });
}));

router.get('/:id/history', permission('view'), wrap(async (req, res) => {
  const id = validateId(req);
  const employee = await visibleEmployee(req, id);
  await ensureAttendanceBlockSchema();
  const data = (await pool.query(`SELECT id,is_blocked,reason,actor_name,created_at
    FROM professional_attendance_block_history WHERE related_profile_ids && $1::uuid[] ORDER BY id DESC LIMIT 100`, [attendanceSourceIds(id)])).rows;
  res.json({ success: true, employee, data });
}));

router.patch('/:id', permission('write'), wrap(async (req, res) => {
  const id = validateId(req);
  if (typeof req.body?.is_blocked !== 'boolean') fail('is_blocked must be true or false.');
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 500) fail('Enter a reason between 3 and 500 characters.');
  if (typeof req.body.expected_blocked !== 'boolean') fail('Refresh the employee list before changing access.');
  await ensureAttendanceBlockSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const profiles = await lockAttendanceProfiles(client, id);
    const employee = await visibleEmployee(req, id, client);
    const cities = scope(req);
    if (cities !== null && profiles.some(p => !cities.includes(Number(p.city_id)))) fail('A linked attendance profile is outside your assigned city access.', 403);
    if (profiles.length !== attendanceSourceIds(id).length) fail('Linked attendance profiles require review.', 409);
    const old = (await client.query(`SELECT is_blocked FROM professional_attendance_blocks
      WHERE professional_id=ANY($1::uuid[])`, [attendanceSourceIds(id)])).rows.some(r => r.is_blocked);
    if (old !== req.body.expected_blocked) fail('Attendance access changed. Refresh the list and try again.', 409);
    if (old === req.body.is_blocked) fail('Employee already has this attendance access status.', 409);
    await client.query(`INSERT INTO professional_attendance_blocks(professional_id,is_blocked,reason,updated_by)
      SELECT unnest($1::uuid[]),$2,$3,$4
      ON CONFLICT(professional_id) DO UPDATE SET is_blocked=EXCLUDED.is_blocked,reason=EXCLUDED.reason,
        updated_by=EXCLUDED.updated_by,updated_at=NOW()`, [attendanceSourceIds(id), req.body.is_blocked, reason, req.blockActor.user_id]);
    await client.query(`INSERT INTO professional_attendance_block_history(professional_id,related_profile_ids,is_blocked,reason,actor_user_id,actor_name)
      VALUES($1,$2,$3,$4,$5,$6)`, [id, attendanceSourceIds(id), req.body.is_blocked, reason, req.blockActor.user_id, req.blockActor.name || req.blockActor.email]);
    await client.query('COMMIT');
    res.json({ success: true, data: { ...employee, is_attendance_blocked: req.body.is_blocked },
      message: req.body.is_blocked ? 'Employee blocked from punch-in and punch-out.' : 'Employee attendance access restored.' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}));
module.exports = router;
