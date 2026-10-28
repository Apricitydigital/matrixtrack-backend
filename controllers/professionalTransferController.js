const pool = require('../config/db');
const { getPermissionCityFilter } = require('../middleware/permissionMiddleware');
const { transferProfessional } = require('../utils/professionalTransfer');

const requireTransferAdmin = async (req,res,next) => {
  try {
    const user = (await pool.query('SELECT role,is_deleted FROM users WHERE user_id=$1', [req.supervisorId])).rows[0];
    if (!user || user.is_deleted || user.role !== 'admin') return res.status(403).json({ message: 'Only an administrator with Professional Access Requests write permission can transfer employees.' });
    next();
  } catch (_) { res.status(500).json({ message: 'Unable to verify transfer access.' }); }
};
const transferRequest = async (req,res) => {
  let client;
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.status(400).json({message:'Invalid request ID.'});
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('approved-professional-list'))");
    const data = await transferProfessional(client, req.params.id, req.body, req.supervisorId, getPermissionCityFilter(req,'field-access-requests','write'));
    await client.query('COMMIT');
    res.json({ success:true, message:'Professional transferred. Previous attendance now counts under the new posting in employee reports. Account details are preserved.', data });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    res.status(error.status || (['40001','40P01','55P03'].includes(error.code) ? 409 : 500)).json({ message:error.status ? error.message : 'Transfer could not be saved. No changes were made. Refresh and try again.' });
  } finally { client?.release(); }
};
module.exports = { requireTransferAdmin, transferRequest };
