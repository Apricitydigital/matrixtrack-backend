const pool = require('../config/db');
const logger = require('../utils/logger');

const VALID_LEAVE_TYPES = new Set(['MEDICAL', 'CASUAL', 'PAID']);
const VALID_PERIODS = new Set(['monthly', 'quarterly', 'half_yearly', 'yearly']);

/**
 * Compute period start date based on period type and current date.
 */
const getPeriodStart = (period) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based

  if (period === 'monthly') {
    return new Date(year, month, 1);
  }
  if (period === 'quarterly') {
    const q = Math.floor(month / 3);
    return new Date(year, q * 3, 1);
  }
  if (period === 'half_yearly') {
    return month < 6 ? new Date(year, 0, 1) : new Date(year, 6, 1);
  }
  // yearly
  return new Date(year, 0, 1);
};

/**
 * @desc    Get leave allocations + week off for a professional
 * @route   GET /api/admin/professional-leave/allocations/:id
 */
const getLeaveAllocations = async (req, res) => {
  const { id } = req.params;
  try {
    const [allocResult, weekOffResult] = await Promise.all([
      pool.query(
        `SELECT leave_type, period, allocated_count, updated_at,
                u_created.name AS created_by_name, u_updated.name AS updated_by_name
         FROM professional_leave_allocations pla
         LEFT JOIN users u_created ON u_created.user_id = pla.created_by
         LEFT JOIN users u_updated ON u_updated.user_id = pla.updated_by
         WHERE pla.professional_id = $1
         ORDER BY leave_type, period`,
        [id]
      ),
      pool.query(
        `SELECT week_off_days, updated_at, u.name AS updated_by_name
         FROM professional_week_off pwo
         LEFT JOIN users u ON u.user_id = pwo.updated_by
         WHERE pwo.professional_id = $1`,
        [id]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        allocations: allocResult.rows,
        week_off: weekOffResult.rows[0] || { week_off_days: [], updated_at: null, updated_by_name: null },
      },
    });
  } catch (error) {
    logger.error('[LeaveAllocations] getLeaveAllocations error:', error);
    return res.status(500).json({ success: false, message: 'Unable to fetch allocations.' });
  }
};

/**
 * @desc    Update leave allocations + week off for a professional (with audit log)
 * @route   PUT /api/admin/professional-leave/allocations/:id
 */
const setLeaveAllocations = async (req, res) => {
  const { id } = req.params;
  const actorUserId = req.user?.user_id || req.user?.id || req.user?.userId;
  const { allocations, week_off_days } = req.body;

  if (!actorUserId) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify employee exists
    const empCheck = await client.query(
      'SELECT id, full_name FROM professional_employees WHERE id = $1 AND is_active = true',
      [id]
    );
    if (empCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Professional employee not found.' });
    }

    // Fetch old values for audit
    const oldAllocResult = await client.query(
      'SELECT leave_type, period, allocated_count FROM professional_leave_allocations WHERE professional_id = $1',
      [id]
    );
    const oldWeekOffResult = await client.query(
      'SELECT week_off_days FROM professional_week_off WHERE professional_id = $1',
      [id]
    );

    const oldValues = {
      allocations: oldAllocResult.rows,
      week_off_days: oldWeekOffResult.rows[0]?.week_off_days || [],
    };

    // Upsert allocations
    const upsertedAllocations = [];
    if (Array.isArray(allocations)) {
      for (const alloc of allocations) {
        const leaveType = String(alloc.leave_type || '').toUpperCase();
        const period = String(alloc.period || '').toLowerCase();
        const count = parseInt(alloc.allocated_count, 10);
        if (!VALID_LEAVE_TYPES.has(leaveType) || !VALID_PERIODS.has(period) || isNaN(count) || count < 0) continue;
        await client.query(
          `INSERT INTO professional_leave_allocations
             (professional_id, leave_type, period, allocated_count, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (professional_id, leave_type, period) DO UPDATE
             SET allocated_count = EXCLUDED.allocated_count,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = NOW()`,
          [id, leaveType, period, count, actorUserId]
        );
        upsertedAllocations.push({ leave_type: leaveType, period, allocated_count: count });
      }
    }

    // Upsert week off
    let finalWeekOff = oldValues.week_off_days;
    if (Array.isArray(week_off_days)) {
      const validDays = week_off_days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      finalWeekOff = validDays;
      await client.query(
        `INSERT INTO professional_week_off (professional_id, week_off_days, created_by, updated_by)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (professional_id) DO UPDATE
           SET week_off_days = EXCLUDED.week_off_days,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()`,
        [id, validDays, actorUserId]
      );
    }

    // Audit log
    const actorRes = await client.query('SELECT name FROM users WHERE user_id = $1 LIMIT 1', [actorUserId]);
    const actorName = actorRes.rows[0]?.name || 'Unknown';
    const newValues = { allocations: upsertedAllocations, week_off_days: finalWeekOff };

    await client.query(
      `INSERT INTO professional_leave_allocation_logs
         (professional_id, actor_user_id, actor_name, change_summary, old_values, new_values)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        actorUserId,
        actorName,
        `Leave allocations updated by ${actorName}`,
        JSON.stringify(oldValues),
        JSON.stringify(newValues),
      ]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Leave allocations updated successfully.',
      data: { allocations: upsertedAllocations, week_off_days: finalWeekOff },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[LeaveAllocations] setLeaveAllocations error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update allocations.' });
  } finally {
    client.release();
  }
};

/**
 * @desc    Get audit logs for a professional's leave allocations
 * @route   GET /api/admin/professional-leave/allocations/:id/logs
 */
const getAllocationLogs = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, actor_user_id, actor_name, change_summary, old_values, new_values, created_at
       FROM professional_leave_allocation_logs
       WHERE professional_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [id]
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    logger.error('[LeaveAllocations] getAllocationLogs error:', error);
    return res.status(500).json({ success: false, message: 'Unable to fetch logs.' });
  }
};

/**
 * @desc    Get leave balance for the authenticated professional
 * @route   GET /professional/leave/balance
 *
 * Returns per leave-type remaining count for the current period.
 * If no allocation exists for a type, returns null (unlimited / not configured).
 */
const getMyLeaveBalance = async (req, res) => {
  const { professional_id } = req.professional || {};
  if (!professional_id) {
    return res.status(401).json({ success: false, message: 'Unauthorized professional session.' });
  }

  try {
    // Get all allocations for this professional
    const allocResult = await pool.query(
      'SELECT leave_type, period, allocated_count FROM professional_leave_allocations WHERE professional_id = $1',
      [professional_id]
    );

    const balance = {};

    for (const alloc of allocResult.rows) {
      const periodStart = getPeriodStart(alloc.period);
      // Count approved leaves in this period for this leave type
      const usedResult = await pool.query(
        `SELECT COUNT(*) AS used
         FROM professional_leave_requests
         WHERE professional_id = $1
           AND leave_type = $2
           AND status = 'approved'
           AND requested_date >= $3`,
        [professional_id, alloc.leave_type, periodStart.toISOString().slice(0, 10)]
      );
      const used = parseInt(usedResult.rows[0]?.used || 0, 10);
      const remaining = Math.max(0, alloc.allocated_count - used);

      // Store the minimum remaining across periods for this leave_type (most restrictive wins)
      if (balance[alloc.leave_type] === undefined || remaining < balance[alloc.leave_type].remaining) {
        balance[alloc.leave_type] = {
          leave_type: alloc.leave_type,
          period: alloc.period,
          allocated: alloc.allocated_count,
          used,
          remaining,
        };
      }
    }

    // Also fetch week off days
    const weekOffResult = await pool.query(
      'SELECT week_off_days FROM professional_week_off WHERE professional_id = $1',
      [professional_id]
    );

    return res.json({
      success: true,
      data: {
        balance: Object.values(balance),
        week_off_days: weekOffResult.rows[0]?.week_off_days || [],
      },
    });
  } catch (error) {
    logger.error('[LeaveAllocations] getMyLeaveBalance error:', error);
    return res.status(500).json({ success: false, message: 'Unable to fetch leave balance.' });
  }
};

module.exports = {
  getLeaveAllocations,
  setLeaveAllocations,
  getAllocationLogs,
  getMyLeaveBalance,
};
