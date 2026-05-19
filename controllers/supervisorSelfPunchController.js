const pool = require('../config/db');
const logger = require('../utils/logger');
const { getSignedS3Url } = require('../utils/s3SelfPunch');
const socketio = require('../utils/socket');
const { decryptAadhar } = require('../utils/encryption');
const bcrypt = require('bcryptjs');
const { sendSms } = require('../utils/smsNotifier');
let professionalEmployeeColumnsCache = null;

const getProfessionalEmployeeColumns = async (client) => {
  if (professionalEmployeeColumnsCache) {
    return professionalEmployeeColumnsCache;
  }

  const { rows } = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'professional_employees'`
  );

  professionalEmployeeColumnsCache = new Set(rows.map((r) => String(r.column_name)));
  return professionalEmployeeColumnsCache;
};

const ensureProfessionalPasswordColumn = async (client) => {
  const cols = await getProfessionalEmployeeColumns(client);
  if (cols.has('password_hash') || cols.has('password')) {
    return;
  }

  await client.query('ALTER TABLE professional_employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)');
  professionalEmployeeColumnsCache = null; // refresh cache after DDL
};

// Helper to generate hierarchy visibility CTE for a reviewer user.
// Supports visibility from:
// - direct ward/kothi assignments
// - zone assignments (all wards/sectors in zone)
// - city assignments (all zones/wards in city)
// - legacy rows where spr.ward_id stores sector_id
const getVisibilityCTE = () => `
  WITH assigned_wards AS (
    SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1
    UNION
    SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
    UNION
    SELECT ward_id FROM user_kothi_access WHERE user_id = $1
  ),
  assigned_sectors AS (
    -- From direct ward assignments -> sectors
    SELECT DISTINCT w.sector_id
    FROM wards w
    JOIN assigned_wards a ON a.ward_id = w.ward_id
    WHERE w.sector_id IS NOT NULL
    UNION
    -- Legacy: assignment may already store sector_id
    SELECT DISTINCT a.ward_id AS sector_id
    FROM assigned_wards a
    JOIN sectors s ON s.sector_id = a.ward_id
    UNION
    -- Zone access expands to all sectors inside the zone
    SELECT DISTINCT s.sector_id
    FROM sectors s
    JOIN user_zone_access uza ON uza.zone_id = s.zone_id
    WHERE uza.user_id = $1
  ),
  assigned_zones AS (
    -- Direct zone assignments
    SELECT zone_id FROM user_zone_access WHERE user_id = $1
    UNION
    -- Zones inferred from ward/kothi assignments
    SELECT DISTINCT COALESCE(w.zone_id, s.zone_id) AS zone_id
    FROM wards w
    LEFT JOIN sectors s ON s.sector_id = w.sector_id
    JOIN assigned_wards a ON a.ward_id = w.ward_id
    WHERE COALESCE(w.zone_id, s.zone_id) IS NOT NULL
    UNION
    SELECT DISTINCT s.zone_id
    FROM sectors s
    JOIN assigned_sectors sec ON sec.sector_id = s.sector_id
    WHERE s.zone_id IS NOT NULL
    UNION
    -- City-level access: expand to ALL zones in that city ONLY when user has no zone restrictions for it
    SELECT DISTINCT z.zone_id
    FROM zones z
    JOIN user_city_access uca ON uca.city_id = z.city_id
    WHERE uca.user_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM user_zone_access uza2
        JOIN zones z2 ON uza2.zone_id = z2.zone_id
        WHERE uza2.user_id = $1 AND z2.city_id = uca.city_id
      )
  ),
  -- Full-city access: user has city access AND no zone-level restrictions for that city
  -- Used in WHERE clause to allow city-level matching only for truly unrestricted city access
  full_city_access AS (
    SELECT uca.city_id
    FROM user_city_access uca
    WHERE uca.user_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM user_zone_access uza2
        JOIN zones z2 ON uza2.zone_id = z2.zone_id
        WHERE uza2.user_id = $1 AND z2.city_id = uca.city_id
      )
  )
`;

// Visibility rules (strictly scoped — no accidental city-wide leak):
// 1) full_city_access: user has city assigned with NO zone restrictions → sees all in that city
// 2) assigned_zones: user sees requests matching their assigned zones (or zones inferred from kothis/wards)
// 3) direct ward/kothi match
// 4) sector-based match
const visibilityWhereClause = `
  (
    spr.city_id IN (SELECT city_id FROM full_city_access)
    OR spr.zone_id IN (SELECT zone_id FROM assigned_zones)
    OR spr.ward_id IN (SELECT ward_id FROM assigned_wards)
    OR spr.ward_id IN (SELECT sector_id FROM assigned_sectors)
    OR spr.kothi_id IN (SELECT ward_id FROM assigned_wards)
  )
`;

/**
 * @desc    Get paginated list of self-punch requests for the supervisor
 * @route   GET /api/supervisor/self-punch/requests
 * @access  Private (Supervisor only)
 */
const getRequests = async (req, res) => {
  const supervisorId = req.supervisorId;
  const requesterRole = String(req.user?.role || '').toLowerCase();
  const isAdmin = requesterRole === 'admin';
  const { status, page = 1, limit = 20 } = req.query;
  const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
  const limitNumber = Math.max(parseInt(limit, 10) || 20, 1);
  const offset = (pageNumber - 1) * limitNumber;

  try {
    const normalizedStatus = ['pending', 'approved', 'rejected'].includes(status) ? status : null;

    const listParams = isAdmin ? [] : [supervisorId];
    let listStatusFilter = '';
    if (normalizedStatus) {
      listParams.push(normalizedStatus);
      listStatusFilter = `AND spr.status = $${listParams.length}`;
    }
    listParams.push(limitNumber);
    const limitParamIndex = listParams.length;
    listParams.push(offset);
    const offsetParamIndex = listParams.length;

    const visibilitySql = isAdmin ? '' : getVisibilityCTE();
    const query = `
      ${visibilitySql}
      SELECT 
        spr.id, spr.full_name, spr.mobile, spr.status, spr.created_at,
        spr.selfie_url, spr.aadhar_doc_url,
        c.city_name,
        z.zone_name,
        COALESCE(s.sector_name, w_from_ward.ward_name) as ward_name,
        w.ward_name as kothi_name,
        att.attendance_state,
        att.punch_in as attendance_punch_in,
        att.punch_out as attendance_punch_out,
        att.hours_worked as attendance_hours_worked
      FROM self_punch_requests spr
      LEFT JOIN cities c ON spr.city_id = c.city_id
      LEFT JOIN zones z ON spr.zone_id = z.zone_id
      LEFT JOIN sectors s ON spr.ward_id = s.sector_id
      LEFT JOIN wards w_from_ward ON spr.ward_id = w_from_ward.ward_id
      LEFT JOIN wards w ON spr.kothi_id = w.ward_id
      LEFT JOIN LATERAL (
        SELECT
          pa.punch_in,
          pa.punch_out,
          ROUND((EXTRACT(EPOCH FROM (COALESCE(pa.punch_out, NOW()) - pa.punch_in)) / 3600)::numeric, 2) as hours_worked,
          CASE
            WHEN pa.punch_in IS NOT NULL AND pa.punch_out IS NOT NULL THEN 'done'
            WHEN pa.punch_in IS NOT NULL THEN 'punched_in'
            ELSE 'not_punched_in'
          END as attendance_state
        FROM professional_attendance pa
        WHERE pa.professional_id = spr.id
          AND pa.date = CURRENT_DATE
        LIMIT 1
      ) att ON spr.status = 'approved'
      WHERE ${isAdmin ? 'TRUE' : visibilityWhereClause} ${listStatusFilter}
      ORDER BY spr.created_at DESC
      LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
    `;

    const { rows } = await pool.query(query, listParams);

    // Generate signed URLs
    const data = await Promise.all(rows.map(async (row) => {
      return {
        ...row,
        selfie_url: row.selfie_url ? await getSignedS3Url(row.selfie_url, 900) : null,
        aadhar_doc_url: row.aadhar_doc_url ? await getSignedS3Url(row.aadhar_doc_url, 900) : null
      };
    }));

    // Get total count
    const countParams = isAdmin ? [] : [supervisorId];
    let countStatusFilter = '';
    if (normalizedStatus) {
      countParams.push(normalizedStatus);
      countStatusFilter = `AND spr.status = $${countParams.length}`;
    }

    const countQuery = `
      ${visibilitySql}
      SELECT COUNT(*) as total 
      FROM self_punch_requests spr 
      WHERE ${isAdmin ? 'TRUE' : visibilityWhereClause} ${countStatusFilter}
    `;
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      success: true,
      data,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        pages: Math.ceil(total / limitNumber)
      }
    });

  } catch (error) {
    logger.error('[Supervisor] Failed to get requests', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * @desc    Get full detail of a single request including logs
 * @route   GET /api/supervisor/self-punch/requests/:id
 * @access  Private (Supervisor only)
 */
const getRequestDetails = async (req, res) => {
  const supervisorId = req.supervisorId;
  const requesterRole = String(req.user?.role || '').toLowerCase();
  const isAdmin = requesterRole === 'admin';
  const { id } = req.params;

  try {
    const visibilitySql = isAdmin ? '' : getVisibilityCTE();
    const idParamIndex = isAdmin ? 1 : 2;
    const query = `
      ${visibilitySql}
      SELECT 
        spr.*,
        c.city_name,
        z.zone_name,
        COALESCE(s.sector_name, w_from_ward.ward_name) as ward_name,
        w.ward_name as kothi_name
      FROM self_punch_requests spr
      LEFT JOIN cities c ON spr.city_id = c.city_id
      LEFT JOIN zones z ON spr.zone_id = z.zone_id
      LEFT JOIN sectors s ON spr.ward_id = s.sector_id
      LEFT JOIN wards w_from_ward ON spr.ward_id = w_from_ward.ward_id
      LEFT JOIN wards w ON spr.kothi_id = w.ward_id
      WHERE spr.id = $${idParamIndex} AND ${isAdmin ? 'TRUE' : visibilityWhereClause}
    `;

    const detailParams = isAdmin ? [id] : [supervisorId, id];
    const { rows } = await pool.query(query, detailParams);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Request not found or access denied.' });
    }

    const request = rows[0];

    // Decrypt Aadhar
    try {
      request.aadhar_number = decryptAadhar(request.aadhar_number);
    } catch (e) {
      request.aadhar_number = 'DECRYPTION_FAILED';
    }

    // Signed URLs
    request.selfie_url = request.selfie_url ? await getSignedS3Url(request.selfie_url, 900) : null;
    request.aadhar_doc_url = request.aadhar_doc_url ? await getSignedS3Url(request.aadhar_doc_url, 900) : null;

    // Fetch Logs
    const logsQuery = `
      SELECT l.*, l.note as comments, u.name as supervisor_name
      FROM self_punch_request_logs l
      LEFT JOIN users u ON l.performed_by_id = u.user_id
      WHERE l.request_id = $1
      ORDER BY l.created_at ASC
    `;
    const logsResult = await pool.query(logsQuery, [id]);
    request.logs = logsResult.rows;

    // Log the viewed action silently
    await pool.query(`
      INSERT INTO self_punch_request_logs (request_id, action, performed_by_type, performed_by_id, note)
      VALUES ($1, 'viewed', 'supervisor', $2, 'Viewed by supervisor')
    `, [id, supervisorId]);

    res.json({ success: true, data: request });

  } catch (error) {
    logger.error(`[Supervisor] Failed to get request detail ${id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * @desc    Approve a request
 * @route   POST /api/supervisor/self-punch/requests/:id/approve
 * @access  Private (Supervisor only)
 */
const approveRequest = async (req, res) => {
  const supervisorId = req.supervisorId;
  const requesterRole = String(req.user?.role || '').toLowerCase();
  const isAdmin = requesterRole === 'admin';
  const { id } = req.params;
  const { note, week_off_days, allocations } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify visibility and status with row lock
    const visibilitySql = isAdmin ? '' : getVisibilityCTE();
    const idParamIndex = isAdmin ? 1 : 2;
    const checkQuery = `
      ${visibilitySql}
      SELECT * FROM self_punch_requests spr
      WHERE spr.id = $${idParamIndex} AND ${isAdmin ? 'TRUE' : visibilityWhereClause}
      FOR UPDATE
    `;

    const checkParams = isAdmin ? [id] : [supervisorId, id];
    const { rows } = await client.query(checkQuery, checkParams);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found or access denied.' });
    }

    const request = rows[0];

    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Cannot approve request with status: ${request.status}` });
    }

    const mobileDigits = String(request.mobile || '').replace(/[^\d]/g, '');
    if (mobileDigits.length < 4) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Cannot approve request: valid mobile number is required to send credentials.'
      });
    }

    // 1. Update Status
    await client.query(`
      UPDATE self_punch_requests SET status = 'approved', updated_at = NOW() WHERE id = $1
    `, [id]);

    // 2. Generate and Hash Password (name@last4mobile)
    const last4 = mobileDigits.slice(-4);
    const normalizedName = String(request.full_name || 'worker')
      .trim()
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 16) || 'worker';
    const plainTextPassword = `${normalizedName}@${last4 || '0000'}`;
    const passwordHash = await bcrypt.hash(plainTextPassword, 10);

    // 3. Insert into professional_employees (schema-compatible across deployments)
    await ensureProfessionalPasswordColumn(client);
    const peColumns = await getProfessionalEmployeeColumns(client);
    const insertCols = [];
    const insertVals = [];

    const pushCol = (col, val) => {
      if (peColumns.has(col)) {
        insertCols.push(col);
        insertVals.push(val);
      }
    };

    pushCol('id', request.id);
    pushCol('request_id', request.id);
    pushCol('full_name', request.full_name);
    pushCol('mobile', request.mobile || '');
    pushCol('email', request.email);
    pushCol('emp_code', request.emp_code || null);

    if (peColumns.has('password_hash')) {
      insertCols.push('password_hash');
      insertVals.push(passwordHash);
    } else if (peColumns.has('password')) {
      // Backward compatibility for old schema
      insertCols.push('password');
      insertVals.push(passwordHash);
    } else {
      throw new Error('professional_employees table has neither password_hash nor password column.');
    }

    pushCol('aadhar_number', request.aadhar_number);
    pushCol('aadhar_doc_url', request.aadhar_doc_url);
    pushCol('selfie_url', request.selfie_url);
    pushCol('city_id', request.city_id);
    pushCol('zone_id', request.zone_id);
    pushCol('ward_id', request.ward_id);
    pushCol('kothi_id', request.kothi_id);
    pushCol('face_locked', true);
    pushCol('is_active', true);

    const placeholders = insertVals.map((_, idx) => `$${idx + 1}`).join(', ');
    const conflictAssignments = ['is_active = true'];
    if (peColumns.has('updated_at')) {
      conflictAssignments.push('updated_at = NOW()');
    }
    const insertPeQuery = `
      INSERT INTO professional_employees (${insertCols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (id) DO UPDATE SET ${conflictAssignments.join(', ')}
      RETURNING id
    `;

    await client.query(insertPeQuery, insertVals);

    // 3b. Save week off days if provided
    if (Array.isArray(week_off_days)) {
      const validDays = week_off_days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      await client.query(`
        INSERT INTO professional_week_off (professional_id, week_off_days, created_by, updated_by)
        VALUES ($1, $2, $3, $3)
        ON CONFLICT (professional_id) DO UPDATE
          SET week_off_days = EXCLUDED.week_off_days,
              updated_by = EXCLUDED.updated_by,
              updated_at = NOW()
      `, [request.id, validDays, supervisorId || null]);
    }

    // 3c. Save leave allocations if provided
    if (Array.isArray(allocations) && allocations.length > 0) {
      for (const alloc of allocations) {
        const leaveType = String(alloc.leave_type || '').toUpperCase();
        const period = String(alloc.period || '').toLowerCase();
        const count = parseInt(alloc.allocated_count, 10);
        const validTypes = new Set(['MEDICAL', 'CASUAL', 'PAID']);
        const validPeriods = new Set(['monthly', 'quarterly', 'half_yearly', 'yearly']);
        if (!validTypes.has(leaveType) || !validPeriods.has(period) || isNaN(count) || count < 0) continue;
        await client.query(`
          INSERT INTO professional_leave_allocations
            (professional_id, leave_type, period, allocated_count, created_by, updated_by)
          VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (professional_id, leave_type, period) DO UPDATE
            SET allocated_count = EXCLUDED.allocated_count,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
        `, [request.id, leaveType, period, count, supervisorId || null]);
      }
      // Log the initial allocation
      const actorRes = supervisorId ? await client.query(
        'SELECT name FROM users WHERE user_id = $1 LIMIT 1', [supervisorId]
      ) : { rows: [] };
      const actorName = actorRes.rows[0]?.name || 'Supervisor';
      await client.query(`
        INSERT INTO professional_leave_allocation_logs
          (professional_id, actor_user_id, actor_name, change_summary, old_values, new_values)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        request.id,
        supervisorId || null,
        actorName,
        'Initial leave allocations set during approval',
        null,
        JSON.stringify({ allocations, week_off_days: week_off_days || [] })
      ]);
    }


    // 4. Log the action
    await client.query(`
      INSERT INTO self_punch_request_logs (request_id, action, performed_by_type, performed_by_id, note)
      VALUES ($1, 'approved', 'supervisor', $2, $3)
    `, [id, supervisorId, note || 'Approved by Supervisor']);

    await client.query('COMMIT');

    // Send approval SMS (non-blocking for API success).
    const credentialMessage = [
      `Hi ${request.full_name},`,
      '',
      'Your MatrixTrack access has been approved successfully.',
      `Email: ${request.email}`,
      `Password: ${plainTextPassword}`,
      '',
      'Welcome to MatrixTrack!🎉'
    ].join('\n');
    let approvalSmsSent = false;
    let approvalSmsError = null;
    try {
      await sendSms({
        phone: request.mobile,
        message: credentialMessage,
        context: 'self-punch-approve'
      });
      approvalSmsSent = true;
    } catch (err) {
      approvalSmsError = {
        message: err.message,
        code: err.code || null,
        statusCode: err.statusCode || null
      };
      logger.warn('[SMS] Approval SMS failed', {
        request_id: id,
        mobile: request.mobile,
        error: err.message,
        code: err.code || null,
        statusCode: err.statusCode || null
      });
    }

    // 5. Emit socket event
    try {
      const io = socketio.getIO();
      // Emitting directly to the user's socket room if they are connected
      io.emit('request_approved', { request_id: id, message: 'Your registration has been approved!' });
    } catch (socketErr) {
      logger.warn(`[Supervisor] Failed to emit request_approved for ${id}:`, socketErr.message);
    }

    logger.info(`[Supervisor] Request ${id} approved by ${supervisorId}`);
    res.json({
      success: true,
      professional_id: request.id,
      message: 'Request approved successfully.',
      sms: { sent: approvalSmsSent, error: approvalSmsError }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`[Supervisor] Failed to approve request ${id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
};

/**
 * @desc    Reject a request
 * @route   POST /api/supervisor/self-punch/requests/:id/reject
 * @access  Private (Supervisor only)
 */
const rejectRequest = async (req, res) => {
  const supervisorId = req.supervisorId;
  const requesterRole = String(req.user?.role || '').toLowerCase();
  const isAdmin = requesterRole === 'admin';
  const { id } = req.params;
  const { note } = req.body;

  if (!note) {
    return res.status(400).json({ success: false, message: 'A rejection note is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify visibility and status with row lock
    const visibilitySql = isAdmin ? '' : getVisibilityCTE();
    const idParamIndex = isAdmin ? 1 : 2;
    const checkQuery = `
      ${visibilitySql}
      SELECT * FROM self_punch_requests spr
      WHERE spr.id = $${idParamIndex} AND ${isAdmin ? 'TRUE' : visibilityWhereClause}
      FOR UPDATE
    `;

    const checkParams = isAdmin ? [id] : [supervisorId, id];
    const { rows } = await client.query(checkQuery, checkParams);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found or access denied.' });
    }

    const request = rows[0];

    if (request.status === 'rejected') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Request is already rejected.' });
    }

    // 1. Update Status
    await client.query(`
      UPDATE self_punch_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1
    `, [id]);

    // 1b. If this was already approved, deactivate the professional account.
    if (request.status === 'approved') {
      await client.query(
        `UPDATE professional_employees
         SET is_active = false
         WHERE request_id = $1 OR id = $1`,
        [id]
      );
    }

    // 2. Log the action
    await client.query(`
      INSERT INTO self_punch_request_logs (request_id, action, performed_by_type, performed_by_id, note)
      VALUES ($1, 'rejected', 'supervisor', $2, $3)
    `, [id, supervisorId, note]);

    await client.query('COMMIT');

    const rejectionMessage =
      request.status === 'approved'
        ? `MatrixTrack: Your professional access has been revoked.\nReason: ${note}`
        : `MatrixTrack: Your professional access request was rejected.\nReason: ${note}`;
    let smsSent = false;
    let smsFailure = null;
    try {
      await sendSms({
        phone: request.mobile,
        message: rejectionMessage,
        context: 'self-punch-reject'
      });
      smsSent = true;
    } catch (err) {
      smsFailure = {
        message: err.message,
        code: err.code || null,
        statusCode: err.statusCode || null
      };
      logger.warn('[SMS] Rejection SMS failed', {
        request_id: id,
        mobile: request.mobile,
        error: err.message,
        code: err.code || null,
        statusCode: err.statusCode || null
      });
    }

    logger.info(`[Supervisor] Request ${id} rejected by ${supervisorId}`);
    res.json({
      success: true,
      message: request.status === 'approved'
        ? 'Request rejected and professional access deactivated successfully.'
        : 'Request rejected successfully.',
      sms: { sent: smsSent, error: smsFailure }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`[Supervisor] Failed to reject request ${id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
};

/**
 * @desc    Get all logs for visible requests
 * @route   GET /api/supervisor/self-punch/requests/logs
 * @access  Private (Supervisor only)
 */
const getLogs = async (req, res) => {
  const supervisorId = req.supervisorId;
  const requesterRole = String(req.user?.role || '').toLowerCase();
  const isAdmin = requesterRole === 'admin';

  try {
    const visibilitySql = isAdmin ? '' : getVisibilityCTE();
    const query = `
      ${visibilitySql}
      SELECT 
        l.id as log_id, l.request_id, l.action, l.note as comments, l.created_at as timestamp,
        spr.full_name as request_full_name,
        u.name as supervisor_name
      FROM self_punch_request_logs l
      JOIN self_punch_requests spr ON l.request_id = spr.id
      LEFT JOIN users u ON l.performed_by_id = u.user_id
      WHERE ${isAdmin ? 'TRUE' : visibilityWhereClause}
      ORDER BY l.created_at DESC
      LIMIT 100
    `;

    const logParams = isAdmin ? [] : [supervisorId];
    const { rows } = await pool.query(query, logParams);

    res.json({ success: true, data: rows });

  } catch (error) {
    logger.error('[Supervisor] Failed to get logs', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getRequests,
  getRequestDetails,
  approveRequest,
  rejectRequest,
  getLogs
};
