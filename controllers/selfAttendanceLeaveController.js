const pool = require("../config/db");
const logger = require("../utils/logger");
const { ensureSelfAttendanceLeaveSchema } = require("../utils/selfAttendanceLeaveSchema");

const ALLOWED_LEAVE_TYPES = new Set(["MEDICAL", "CASUAL", "PAID"]);

const normalizeLeaveType = (value) => String(value || "").trim().toUpperCase();

const getIstDateKey = (value = new Date()) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(value);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

const toISTDate = () => getIstDateKey(new Date());

const requestLeave = async (req, res) => {
  const { self_attendance_id } = req.self_attendance || {};
  const rawDate = String(req.body?.date || req.body?.requested_date || "").trim();
  const leaveType = normalizeLeaveType(req.body?.leave_type || req.body?.leaveType);
  const reason = String(req.body?.reason || "").trim();

  if (!self_attendance_id) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return res.status(400).json({ success: false, message: "date must be in YYYY-MM-DD format." });
  }
  if (!ALLOWED_LEAVE_TYPES.has(leaveType)) {
    return res.status(400).json({
      success: false,
      message: "Invalid leave_type.",
      allowed: Array.from(ALLOWED_LEAVE_TYPES),
    });
  }

  const today = toISTDate();
  if (rawDate < today) {
    return res.status(400).json({ success: false, message: "Leave can only be requested for today or future dates." });
  }

  let client;
  try {
    client = await pool.connect();
    await ensureSelfAttendanceLeaveSchema();
    await client.query("BEGIN");

    const selfAttendanceCheck = await client.query(
      `SELECT id FROM self_attendance_employees WHERE id = $1 AND is_active = true`,
      [self_attendance_id]
    );
    if (selfAttendanceCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Self Attendance profile not found or inactive." });
    }

    // Check leave balance (only enforce if an allocation exists for this leave type)
    const allocResult = await client.query(
      `SELECT period, allocated_count FROM self_attendance_leave_allocations
       WHERE self_attendance_id = $1 AND leave_type = $2
       ORDER BY
         CASE period
           WHEN 'monthly' THEN 1
           WHEN 'quarterly' THEN 2
           WHEN 'half_yearly' THEN 3
           WHEN 'yearly' THEN 4
           ELSE 5
         END
       LIMIT 1`,
      [self_attendance_id, leaveType]
    );

    if (allocResult.rows.length > 0) {
      const alloc = allocResult.rows[0];
      const getPeriodStart = (period) => {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        if (period === 'monthly') return new Date(year, month, 1);
        if (period === 'quarterly') return new Date(year, Math.floor(month / 3) * 3, 1);
        if (period === 'half_yearly') return month < 6 ? new Date(year, 0, 1) : new Date(year, 6, 1);
        return new Date(year, 0, 1);
      };
      const periodStart = getPeriodStart(alloc.period);
      const usedResult = await client.query(
        `SELECT COUNT(*) AS used
         FROM self_attendance_leave_requests
         WHERE self_attendance_id = $1
           AND leave_type = $2
           AND status = 'approved'
           AND requested_date >= $3`,
        [self_attendance_id, leaveType, periodStart.toISOString().slice(0, 10)]
      );
      const used = parseInt(usedResult.rows[0]?.used || 0, 10);
      const remaining = alloc.allocated_count - used;
      if (remaining <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `You have used all your ${leaveType} leave quota (${alloc.allocated_count} per ${alloc.period}). No remaining balance.`,
          remaining: 0,
        });
      }
    }

    const existing = await client.query(
      `SELECT id, status
       FROM self_attendance_leave_requests
       WHERE self_attendance_id = $1 AND requested_date = $2
       FOR UPDATE`,
      [self_attendance_id, rawDate]
    );

    let requestId;
    let finalStatus = "pending";
    let actionLabel = "submitted";

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.status === "approved") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Leave is already approved for this date. Contact supervisor for changes.",
        });
      }

      requestId = row.id;
      actionLabel = row.status === "rejected" ? "resubmitted" : "submitted";
      await client.query(
        `UPDATE self_attendance_leave_requests
         SET leave_type = $1,
             reason = $2,
             status = 'pending',
             requested_at = NOW(),
             reviewed_by = NULL,
             reviewed_at = NULL,
             review_note = NULL
         WHERE id = $3`,
        [leaveType, reason || null, requestId]
      );
    } else {
      const insert = await client.query(
        `INSERT INTO self_attendance_leave_requests (
          self_attendance_id, requested_date, leave_type, reason, status
        )
        VALUES ($1, $2, $3, $4, 'pending')
        RETURNING id, status`,
        [self_attendance_id, rawDate, leaveType, reason || null]
      );
      requestId = insert.rows[0].id;
      finalStatus = insert.rows[0].status;
    }

    await client.query(
      `INSERT INTO self_attendance_leave_request_logs (
        request_id, action, actor_type, actor_self_attendance_id, note
      )
      VALUES ($1, $2, 'self_attendance', $3, $4)`,
      [requestId, actionLabel, self_attendance_id, reason || null]
    );

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Leave request submitted.",
      data: {
        id: requestId,
        requested_date: rawDate,
        leave_type: leaveType,
        status: finalStatus,
      },
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // Ignore rollback failure and return primary error response.
      }
    }
    logger.error("[SelfAttendanceLeave] requestLeave error:", error);
    return res.status(500).json({ success: false, message: "Unable to submit leave request." });
  } finally {
    if (client) {
      client.release();
    }
  }
};

const getMyLeaveRequests = async (req, res) => {
  const { self_attendance_id } = req.self_attendance || {};
  let { month } = req.query;
  const status = String(req.query?.status || "").trim().toLowerCase();

  if (!self_attendance_id) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    const now = new Date();
    month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  const [yyyy, mm] = month.split("-");
  const params = [self_attendance_id, yyyy, mm];
  let statusFilter = "";
  if (["pending", "approved", "rejected"].includes(status)) {
    params.push(status);
    statusFilter = `AND plr.status = $${params.length}`;
  }

  try {
    await ensureSelfAttendanceLeaveSchema();
    const { rows } = await pool.query(
      `SELECT
         plr.id,
         plr.requested_date::text AS requested_date,
         plr.leave_type,
         plr.reason,
         plr.status,
         plr.requested_at,
         plr.review_note,
         plr.reviewed_at,
         u.name AS reviewed_by_name
       FROM self_attendance_leave_requests plr
       LEFT JOIN users u ON u.user_id = plr.reviewed_by
       WHERE plr.self_attendance_id = $1
         AND EXTRACT(YEAR FROM plr.requested_date) = $2
         AND EXTRACT(MONTH FROM plr.requested_date) = $3
         ${statusFilter}
       ORDER BY plr.requested_date DESC, plr.requested_at DESC`,
      params
    );

    // Fetch leave balance per type
    const getPeriodStart = (period) => {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      if (period === 'monthly') return new Date(year, month, 1);
      if (period === 'quarterly') return new Date(year, Math.floor(month / 3) * 3, 1);
      if (period === 'half_yearly') return month < 6 ? new Date(year, 0, 1) : new Date(year, 6, 1);
      return new Date(year, 0, 1);
    };
    const allocResult = await pool.query(
      'SELECT leave_type, period, allocated_count FROM self_attendance_leave_allocations WHERE self_attendance_id = $1',
      [self_attendance_id]
    );
    const balance = {};
    for (const alloc of allocResult.rows) {
      const periodStart = getPeriodStart(alloc.period);
      const usedRes = await pool.query(
        `SELECT COUNT(*) AS used FROM self_attendance_leave_requests
         WHERE self_attendance_id = $1 AND leave_type = $2 AND status = 'approved' AND requested_date >= $3`,
        [self_attendance_id, alloc.leave_type, periodStart.toISOString().slice(0, 10)]
      );
      const used = parseInt(usedRes.rows[0]?.used || 0, 10);
      const remaining = Math.max(0, alloc.allocated_count - used);
      if (balance[alloc.leave_type] === undefined || remaining < balance[alloc.leave_type].remaining) {
        balance[alloc.leave_type] = { leave_type: alloc.leave_type, period: alloc.period, allocated: alloc.allocated_count, used, remaining };
      }
    }

    return res.json({ success: true, data: rows, balance: Object.values(balance) });
  } catch (error) {
    logger.error("[SelfAttendanceLeave] getMyLeaveRequests error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch leave requests." });
  }
};

const getMyNotifications = async (req, res) => {
  const { self_attendance_id } = req.self_attendance || {};
  const limit = Math.max(parseInt(req.query?.limit, 10) || 25, 1);

  if (!self_attendance_id) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }

  try {
    await ensureSelfAttendanceLeaveSchema();
    const { rows } = await pool.query(
      `SELECT id, type, title, message, metadata, is_read, created_at
       FROM self_attendance_notifications
       WHERE self_attendance_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [self_attendance_id, limit]
    );

    return res.json({
      success: true,
      data: rows,
      unread: rows.filter((row) => !row.is_read).length,
    });
  } catch (error) {
    logger.error("[SelfAttendanceLeave] getMyNotifications error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch notifications." });
  }
};

const markNotificationRead = async (req, res) => {
  const { self_attendance_id } = req.self_attendance || {};
  const { id } = req.params;

  if (!self_attendance_id) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }

  try {
    await ensureSelfAttendanceLeaveSchema();
    const updateResult = await pool.query(
      `UPDATE self_attendance_notifications
       SET is_read = TRUE
       WHERE id = $1 AND self_attendance_id = $2
       RETURNING id`,
      [id, self_attendance_id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.json({ success: true, message: "Notification marked as read." });
  } catch (error) {
    logger.error("[SelfAttendanceLeave] markNotificationRead error:", error);
    return res.status(500).json({ success: false, message: "Unable to update notification." });
  }
};

module.exports = {
  requestLeave,
  getMyLeaveRequests,
  getMyNotifications,
  markNotificationRead,
};
