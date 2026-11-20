const pool = require('../config/db');
const { getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { editSelfAttendanceDetails } = require('../utils/selfAttendanceDetailsEdit');

async function editRequestDetails(req, res) {
  let client;
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request ID.' });
    }
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-self-attendance-list'))");
    const data = await editSelfAttendanceDetails(client, req.params.id, req.body || {}, req.supervisorId,
      getPermissionCityFilter(req, 'field-access-requests', 'write'));
    await client.query('COMMIT');
    res.json({ success: true, message: data.changed ? 'Employee details updated and recorded in the activity log.' : 'No details changed.', data });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    res.status(error.status || (['23505','40001','40P01','55P03'].includes(error.code) ? 409 : 500)).json({
      message: error.status ? error.message : 'Details could not be saved. No changes were made. Refresh and try again.',
    });
  } finally { client?.release(); }
}

module.exports = { editRequestDetails };
