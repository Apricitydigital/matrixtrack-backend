const pool = require("../config/db");
const logger = require("../utils/logger");
const { buildVisibilityScope } = require("../utils/professionalAccess");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");

const formatLeaveDate = (value) => {
  if (!value) return "";
  const raw = String(value);
  const parsed = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw.slice(0, 10);
  return parsed.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
};

const getLeaveRequests = async (req, res) => {
  const {
    status,
    page = 1,
    limit = 20,
    city_id,
    zone_id,
    ward_id,
    kothi_id,
    professional_id,
    date,
  } = req.query;

  const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
  const normalizedLimit = Math.max(parseInt(limit, 10) || 20, 1);
  const offset = (normalizedPage - 1) * normalizedLimit;
  const normalizedStatus = String(status || "").trim().toLowerCase();

  try {
    await ensureProfessionalLeaveSchema();
    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");

    let filters = `AND ${whereClause} AND pe.is_active = true`;
    if (["pending", "approved", "rejected"].includes(normalizedStatus)) {
      params.push(normalizedStatus);
      filters += ` AND plr.status = $${params.length}`;
    }
    if (professional_id) {
      params.push(professional_id);
      filters += ` AND pe.id = $${params.length}`;
    }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      params.push(date);
      filters += ` AND plr.requested_date = $${params.length}`;
    }
    if (city_id) {
      params.push(city_id);
      filters += ` AND pe.city_id = $${params.length}`;
    }
    if (zone_id) {
      params.push(zone_id);
      filters += ` AND pe.zone_id = $${params.length}`;
    }
    if (ward_id) {
      params.push(ward_id);
      filters += ` AND pe.ward_id = $${params.length}`;
    }
    if (kothi_id) {
      params.push(kothi_id);
      filters += ` AND pe.kothi_id = $${params.length}`;
    }

    const dataParams = [...params, normalizedLimit, offset];
    const dataQuery = `
      ${cte}
      SELECT
        plr.id,
        plr.professional_id,
        pe.full_name,
        pe.mobile,
        plr.requested_date,
        plr.leave_type,
        plr.reason,
        plr.status,
        plr.requested_at,
        plr.review_note,
        plr.reviewed_at,
        reviewer.name AS reviewed_by_name,
        c.city_name,
        z.zone_name,
        COALESCE(sec_req.sector_name, w_req.ward_name, sec.sector_name, w.ward_name) AS ward_name,
        COALESCE(wk_req.ward_name, wk.ward_name) AS kothi_name
      FROM professional_leave_requests plr
      JOIN professional_employees pe ON pe.id = plr.professional_id
      LEFT JOIN users reviewer ON reviewer.user_id = plr.reviewed_by
      LEFT JOIN self_punch_requests spr ON pe.request_id = spr.id
      LEFT JOIN sectors sec_req ON spr.ward_id = sec_req.sector_id
      LEFT JOIN wards w_req ON spr.ward_id = w_req.ward_id
      LEFT JOIN wards wk_req ON spr.kothi_id = wk_req.ward_id
      LEFT JOIN sectors sec ON pe.ward_id = sec.sector_id
      LEFT JOIN wards w ON pe.ward_id = w.ward_id
      LEFT JOIN wards wk ON pe.kothi_id = wk.ward_id
      LEFT JOIN zones z ON pe.zone_id = z.zone_id
      LEFT JOIN cities c ON pe.city_id = c.city_id
      WHERE 1=1 ${filters}
      ORDER BY
        CASE WHEN plr.status = 'pending' THEN 0 ELSE 1 END,
        plr.requested_date DESC,
        plr.requested_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const countQuery = `
      ${cte}
      SELECT COUNT(*) AS total
      FROM professional_leave_requests plr
      JOIN professional_employees pe ON pe.id = plr.professional_id
      WHERE 1=1 ${filters}
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(countQuery, params),
    ]);

    const total = parseInt(countResult.rows[0]?.total || 0, 10);
    return res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page: normalizedPage,
        limit: normalizedLimit,
        total,
        pages: Math.max(1, Math.ceil(total / normalizedLimit)),
      },
    });
  } catch (error) {
    logger.error("[ProfessionalLeaveMgmt] getLeaveRequests error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch leave requests." });
  }
};

const reviewLeaveRequest = async (req, res, decision) => {
  const requesterRole = String(req.user?.role || "").toLowerCase();
  const actorType = requesterRole === "admin" ? "admin" : "supervisor";
  const reviewerId = req.user?.user_id || req.user?.id || req.user?.userId;
  const { id } = req.params;
  const note = String(req.body?.note || req.body?.reason || "").trim();

  if (!reviewerId) {
    return res.status(401).json({ success: false, message: "Unauthorized reviewer context." });
  }
  if (decision === "rejected" && !note) {
    return res.status(400).json({ success: false, message: "Rejection reason is required." });
  }

  const client = await pool.connect();
  try {
    await ensureProfessionalLeaveSchema();
    await client.query("BEGIN");

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");
    const scopedParams = [...params, id];
    const scopedQuery = `
      ${cte}
      SELECT
        plr.id,
        plr.professional_id,
        plr.requested_date,
        plr.leave_type,
        plr.status,
        pe.full_name
      FROM professional_leave_requests plr
      JOIN professional_employees pe ON pe.id = plr.professional_id
      WHERE plr.id = $${scopedParams.length}
        AND pe.is_active = true
        AND ${whereClause}
      FOR UPDATE
    `;

    const scopedResult = await client.query(scopedQuery, scopedParams);
    if (scopedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Leave request not found or access denied." });
    }

    const request = scopedResult.rows[0];
    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Request already ${request.status}.`,
      });
    }

    await client.query(
      `UPDATE professional_leave_requests
       SET status = $1,
           reviewed_by = $2,
           reviewed_at = NOW(),
           review_note = $3
       WHERE id = $4`,
      [decision, reviewerId, note || null, id]
    );

    await client.query(
      `INSERT INTO professional_leave_request_logs (
        request_id, action, actor_type, actor_user_id, note
      )
      VALUES ($1, $2, $3, $4, $5)`,
      [id, decision, actorType, reviewerId, note || null]
    );

    const leaveDateLabel = formatLeaveDate(request.requested_date);

    await client.query(
      `INSERT INTO professional_notifications (
        professional_id, type, title, message, metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        request.professional_id,
        "leave-review",
        decision === "approved" ? "Leave Approved" : "Leave Rejected",
        decision === "approved"
          ? `Your ${request.leave_type} leave request for ${leaveDateLabel} has been approved.`
          : `Your ${request.leave_type} leave request for ${leaveDateLabel} was rejected.`,
        JSON.stringify({
          request_id: id,
          status: decision,
          requested_date: request.requested_date,
          leave_type: request.leave_type,
          review_note: note || null,
          reviewed_by: reviewerId,
        }),
      ]
    );

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: decision === "approved" ? "Leave request approved." : "Leave request rejected.",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[ProfessionalLeaveMgmt] reviewLeaveRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to review leave request." });
  } finally {
    client.release();
  }
};

const approveLeaveRequest = async (req, res) => reviewLeaveRequest(req, res, "approved");
const rejectLeaveRequest = async (req, res) => reviewLeaveRequest(req, res, "rejected");

module.exports = {
  getLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
};
