const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { attendanceSourceIds } = require('./professionalAttendanceIdentity');

let ready;
function markAttendanceBlockSchemaReady() {
  // Startup calls this only after its migration transaction has committed.
  // The first employee request must not repeat the startup DDL.
  ready = Promise.resolve();
}
function ensureAttendanceBlockSchema() {
  if (!ready) ready = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('professional-attendance-block-schema'))");
      await client.query(fs.readFileSync(path.join(__dirname, '../db/migrations/20261021_professional_attendance_blocks.sql'), 'utf8'));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  })().catch(error => { ready = null; throw error; });
  return ready;
}

// All punch writers and block/unblock actions acquire these same locks, in order.
// Lock every reviewed alias so switching login cannot bypass a block.
async function lockAttendanceProfiles(client, id, includePunchProfile = false) {
  return (await client.query(`SELECT id,city_id${includePunchProfile ? ',selfie_url,is_active' : ''} FROM professional_employees
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [attendanceSourceIds(id)])).rows;
}

async function loadPunchInContext(client, id) {
  // Reuse the existing profile-lock query for profile data, including all reviewed
  // aliases. Block/unblock uses the same locks in the same order.
  const profiles = await lockAttendanceProfiles(client, id, true);
  const profile = profiles.find(row => row.id === String(id).toLowerCase());
  if (!profile?.is_active) return { profile };

  // This is intentionally a SECOND statement after acquiring the profile locks.
  // Reading block state in the lock statement itself can use a snapshot from
  // before a concurrent admin's block committed while we waited for that lock.
  // Combine the fresh block read with the existing cutoff/settings query instead.
  const { rows } = await client.query(`SELECT t.cutoff_time,
    transaction_timestamp() AS attempted_at,
    s.enabled AND (transaction_timestamp() AT TIME ZONE 'Asia/Kolkata') >
      ((transaction_timestamp() AT TIME ZONE 'Asia/Kolkata')::date + t.cutoff_time + INTERVAL '15 minutes') AS is_late,
    (SELECT row_to_json(b) FROM (
      SELECT reason,updated_at FROM professional_attendance_blocks
      WHERE professional_id=ANY($2::uuid[]) AND is_blocked=TRUE
      ORDER BY updated_at DESC LIMIT 1
    ) b) AS attendance_block
    FROM professional_employees p LEFT JOIN professional_punch_cutoffs t ON t.professional_id=p.id
    CROSS JOIN professional_punch_settings s WHERE p.id=$1 AND s.id=1 FOR SHARE OF s`, [id, attendanceSourceIds(id)]);
  if (!rows.length) throw new Error('Attendance settings are unavailable.');
  const cutoff = rows[0];
  const block = { is_attendance_blocked: !!cutoff.attendance_block,
    attendance_block_reason: cutoff.attendance_block?.reason || null,
    attendance_blocked_at: cutoff.attendance_block?.updated_at || null };
  return { profile, cutoff, block };
}

async function getAttendanceBlock(id, client = pool) {
  const { rows } = await client.query(`SELECT reason,updated_at FROM professional_attendance_blocks
    WHERE professional_id=ANY($1::uuid[]) AND is_blocked=TRUE ORDER BY updated_at DESC LIMIT 1`, [attendanceSourceIds(id)]);
  return { is_attendance_blocked: !!rows.length, attendance_block_reason: rows[0]?.reason || null,
    attendance_blocked_at: rows[0]?.updated_at || null };
}

function sendBlocked(res, block) {
  return res.status(403).json({ success: false, code: 'ATTENDANCE_BLOCKED', ...block,
    message: 'Your attendance has been blocked by an administrator. You cannot punch in or punch out. Please contact your administrator.' });
}

// Used by integrations that can also submit punches. Administrative historical
// corrections and scheduled auto-close remain separate from employee punching.
async function withUnblockedAttendance(id, write) {
  await ensureAttendanceBlockSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockAttendanceProfiles(client, id);
    const block = await getAttendanceBlock(id, client);
    if (block.is_attendance_blocked) throw Object.assign(new Error('Attendance is blocked for this employee.'),
      { status: 403, code: 'ATTENDANCE_BLOCKED', attendanceBlock: block });
    const result = await write(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Add a current access badge; never replace historical attendance/payable statuses.
async function withAttendanceBlocks(rows) {
  if (!rows.length) return rows;
  await ensureAttendanceBlockSchema();
  return readAttendanceBlocks(rows);
}

async function readAttendanceBlocks(rows, client = pool) {
  const ids = [...new Set(rows.flatMap(row => attendanceSourceIds(row.professional_id || row.id)))].filter(Boolean);
  if (!ids.length) return rows;
  const blocks = (await client.query(`SELECT professional_id,reason,updated_at FROM professional_attendance_blocks
    WHERE professional_id=ANY($1::uuid[]) AND is_blocked=TRUE`, [ids])).rows;
  const byId = new Map(blocks.flatMap(block => attendanceSourceIds(block.professional_id).map(id => [id, block])));
  return rows.map(row => {
    const block = byId.get(row.professional_id || row.id);
    return block ? { ...row, is_attendance_blocked: true, attendance_block_reason: block.reason,
      attendance_blocked_at: block.updated_at } : row;
  });
}

module.exports = { ensureAttendanceBlockSchema, markAttendanceBlockSchemaReady, lockAttendanceProfiles, loadPunchInContext, getAttendanceBlock, sendBlocked, withAttendanceBlocks, readAttendanceBlocks, withUnblockedAttendance };
