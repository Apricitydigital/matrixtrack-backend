const pool = require("../config/db");
const logger = require("../utils/logger");
const { buildVisibilityScope } = require("../utils/professionalAccess");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");
const { fetchUserZoneAccess } = require("../utils/userZoneAccess");
const { fetchUserKothiAccess } = require("../utils/userKothiAccess");

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

const hasCityAccess = (req, cityId) => {
  const numericCityId = Number(cityId);
  if (!Number.isInteger(numericCityId) || numericCityId <= 0) return false;
  const scope = req.cityScope || { all: false, ids: [] };
  if (scope.all) return true;
  if (!Array.isArray(scope.ids) || scope.ids.length === 0) return false;
  return scope.ids.includes(numericCityId);
};

const toUniqueIntList = (values = []) => {
  const seen = new Set();
  const normalized = [];
  (values || []).forEach((raw) => {
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0 && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  });
  return normalized;
};

const isAdminRequest = (req) =>
  String(req.user?.role || "").trim().toLowerCase() === "admin";

const resolveHolidayAccessScope = async (req) => {
  if (isAdminRequest(req)) {
    return {
      isAdmin: true,
      zoneIds: [],
      sectorIds: [],
      kothiIds: [],
    };
  }

  const [zoneScope, kothiScope] = await Promise.all([
    fetchUserZoneAccess(req.user, { allowCityFallback: true }),
    fetchUserKothiAccess(req.user, {
      allowZoneFallback: true,
      allowCityFallback: false,
    }),
  ]);

  const zoneIds = toUniqueIntList(zoneScope?.ids || []);
  const kothiIds = toUniqueIntList(kothiScope?.ids || []);
  let sectorIds = [];

  if (kothiIds.length > 0) {
    const sectorRows = await pool.query(
      `SELECT DISTINCT sector_id
       FROM wards
       WHERE ward_id = ANY($1::int[]) AND sector_id IS NOT NULL`,
      [kothiIds]
    );
    sectorIds = toUniqueIntList(sectorRows.rows.map((row) => row.sector_id));
  }

  return {
    isAdmin: false,
    zoneIds,
    sectorIds,
    kothiIds,
  };
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

const getHolidayCalendar = async (req, res) => {
  const {
    month,
    city_id,
    zone_id,
    ward_id,
    kothi_id,
    page = 1,
    limit = 50,
  } = req.query;

  const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const offset = (normalizedPage - 1) * normalizedLimit;

  try {
    await ensureProfessionalLeaveSchema();
    const holidayScope = await resolveHolidayAccessScope(req);

    const scope = req.cityScope || { all: false, ids: [] };
    const params = [];
    let filters = "WHERE 1=1";

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [yyyy, mm] = month.split("-");
      params.push(yyyy, mm);
      filters += ` AND EXTRACT(YEAR FROM h.holiday_date) = $${params.length - 1} AND EXTRACT(MONTH FROM h.holiday_date) = $${params.length}`;
    }

    if (city_id) {
      if (!hasCityAccess(req, city_id)) {
        return res.status(403).json({ success: false, message: "No access to selected city." });
      }
      params.push(Number(city_id));
      filters += ` AND h.city_id = $${params.length}`;
    } else if (!scope.all) {
      if (!Array.isArray(scope.ids) || scope.ids.length === 0) {
        return res.json({
          success: true,
          data: [],
          pagination: { page: normalizedPage, limit: normalizedLimit, total: 0, pages: 1 },
        });
      }
      params.push(scope.ids);
      filters += ` AND h.city_id = ANY($${params.length}::int[])`;
    }

    if (zone_id) {
      const requestedZoneId = Number(zone_id);
      if (
        !holidayScope.isAdmin &&
        Number.isInteger(requestedZoneId) &&
        holidayScope.zoneIds.length > 0 &&
        !holidayScope.zoneIds.includes(requestedZoneId)
      ) {
        return res.status(403).json({ success: false, message: "No access to selected zone." });
      }
      params.push(Number(zone_id));
      filters += ` AND h.zone_id = $${params.length}`;
    }
    if (ward_id) {
      const requestedWardId = Number(ward_id);
      if (
        !holidayScope.isAdmin &&
        Number.isInteger(requestedWardId) &&
        holidayScope.sectorIds.length > 0 &&
        !holidayScope.sectorIds.includes(requestedWardId)
      ) {
        return res.status(403).json({ success: false, message: "No access to selected ward." });
      }
      params.push(Number(ward_id));
      filters += ` AND h.ward_id = $${params.length}`;
    }
    if (kothi_id) {
      const requestedKothiId = Number(kothi_id);
      if (
        !holidayScope.isAdmin &&
        Number.isInteger(requestedKothiId) &&
        holidayScope.kothiIds.length > 0 &&
        !holidayScope.kothiIds.includes(requestedKothiId)
      ) {
        return res.status(403).json({ success: false, message: "No access to selected kothi." });
      }
      params.push(Number(kothi_id));
      filters += ` AND h.kothi_id = $${params.length}`;
    }

    if (!holidayScope.isAdmin) {
      if (
        holidayScope.zoneIds.length === 0 &&
        holidayScope.sectorIds.length === 0 &&
        holidayScope.kothiIds.length === 0
      ) {
        return res.json({
          success: true,
          data: [],
          pagination: { page: normalizedPage, limit: normalizedLimit, total: 0, pages: 1 },
        });
      }

      const scopeClauses = ["(h.kothi_id IS NULL AND h.ward_id IS NULL AND h.zone_id IS NULL)"];
      if (holidayScope.kothiIds.length > 0) {
        params.push(holidayScope.kothiIds);
        scopeClauses.push(`(h.kothi_id IS NOT NULL AND h.kothi_id = ANY($${params.length}::int[]))`);
      }
      if (holidayScope.sectorIds.length > 0) {
        params.push(holidayScope.sectorIds);
        scopeClauses.push(`(h.kothi_id IS NULL AND h.ward_id IS NOT NULL AND h.ward_id = ANY($${params.length}::int[]))`);
      }
      if (holidayScope.zoneIds.length > 0) {
        params.push(holidayScope.zoneIds);
        scopeClauses.push(`(h.kothi_id IS NULL AND h.ward_id IS NULL AND h.zone_id IS NOT NULL AND h.zone_id = ANY($${params.length}::int[]))`);
      }
      filters += ` AND (${scopeClauses.join(" OR ")})`;
    }

    const dataQuery = `
      SELECT
        h.id,
        h.holiday_date,
        h.holiday_name,
        h.description,
        h.city_id,
        c.city_name,
        h.zone_id,
        z.zone_name,
        h.ward_id,
        sec.sector_name AS ward_name,
        h.kothi_id,
        wk.ward_name AS kothi_name,
        h.created_at,
        creator.name AS created_by_name
      FROM professional_holidays h
      LEFT JOIN cities c ON c.city_id = h.city_id
      LEFT JOIN zones z ON z.zone_id = h.zone_id
      LEFT JOIN sectors sec ON sec.sector_id = h.ward_id
      LEFT JOIN wards wk ON wk.ward_id = h.kothi_id
      LEFT JOIN users creator ON creator.user_id = h.created_by
      ${filters}
      ORDER BY h.holiday_date DESC, h.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM professional_holidays h
      ${filters}
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, [...params, normalizedLimit, offset]),
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
    logger.error("[ProfessionalLeaveMgmt] getHolidayCalendar error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch holiday calendar." });
  }
};

const createHoliday = async (req, res) => {
  const actorUserId = req.user?.user_id || req.user?.id || req.user?.userId;
  const {
    holiday_date,
    holiday_name,
    description,
    city_id,
    zone_id,
    ward_id,
    kothi_id,
  } = req.body || {};

  if (!actorUserId) {
    return res.status(401).json({ success: false, message: "Unauthorized reviewer context." });
  }
  if (!holiday_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(holiday_date))) {
    return res.status(400).json({ success: false, message: "Valid holiday_date is required (YYYY-MM-DD)." });
  }
  const cleanName = String(holiday_name || "").trim();
  if (!cleanName) {
    return res.status(400).json({ success: false, message: "holiday_name is required." });
  }
  if (!city_id || !hasCityAccess(req, city_id)) {
    return res.status(403).json({ success: false, message: "No access to selected city." });
  }

  const cityId = Number(city_id);
  let zoneId = zone_id ? Number(zone_id) : null;
  let wardId = ward_id ? Number(ward_id) : null;
  const kothiId = kothi_id ? Number(kothi_id) : null;

  try {
    await ensureProfessionalLeaveSchema();
    const holidayScope = await resolveHolidayAccessScope(req);

    if (!holidayScope.isAdmin && !zoneId && !wardId && !kothiId) {
      const [totalZonesResult, allowedZonesResult] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total FROM zones WHERE city_id = $1`, [cityId]),
        holidayScope.zoneIds.length > 0
          ? pool.query(
              `SELECT COUNT(*)::int AS total FROM zones WHERE city_id = $1 AND zone_id = ANY($2::int[])`,
              [cityId, holidayScope.zoneIds]
            )
          : Promise.resolve({ rows: [{ total: 0 }] }),
      ]);
      const totalZones = Number(totalZonesResult.rows[0]?.total || 0);
      const allowedZones = Number(allowedZonesResult.rows[0]?.total || 0);
      if (totalZones === 0 || allowedZones !== totalZones) {
        return res.status(403).json({
          success: false,
          message: "No access to declare holiday for all zones in selected city.",
        });
      }
    }

    if (!holidayScope.isAdmin && zoneId && !holidayScope.zoneIds.includes(zoneId)) {
      return res.status(403).json({ success: false, message: "No access to selected zone." });
    }
    if (!holidayScope.isAdmin && wardId && !holidayScope.sectorIds.includes(wardId)) {
      return res.status(403).json({ success: false, message: "No access to selected ward." });
    }
    if (!holidayScope.isAdmin && kothiId && !holidayScope.kothiIds.includes(kothiId)) {
      return res.status(403).json({ success: false, message: "No access to selected kothi." });
    }

    if (zoneId && Number.isInteger(zoneId)) {
      const zoneResult = await pool.query(
        `SELECT zone_id, city_id FROM zones WHERE zone_id = $1 LIMIT 1`,
        [zoneId]
      );
      const zoneRow = zoneResult.rows[0];
      if (!zoneRow || Number(zoneRow.city_id) !== cityId) {
        return res.status(400).json({ success: false, message: "Selected zone does not belong to selected city." });
      }
    }

    if (wardId && Number.isInteger(wardId)) {
      const wardResult = await pool.query(
        `SELECT s.sector_id, s.zone_id, z.city_id
         FROM sectors s
         JOIN zones z ON z.zone_id = s.zone_id
         WHERE s.sector_id = $1
         LIMIT 1`,
        [wardId]
      );
      const wardRow = wardResult.rows[0];
      if (!wardRow) {
        return res.status(400).json({ success: false, message: "Selected ward is invalid." });
      }
      if (Number(wardRow.city_id) !== cityId) {
        return res.status(400).json({ success: false, message: "Selected ward does not belong to selected city." });
      }
      if (zoneId && Number(wardRow.zone_id) !== zoneId) {
        return res.status(400).json({ success: false, message: "Selected ward does not belong to selected zone." });
      }
      if (!zoneId) {
        zoneId = Number(wardRow.zone_id);
      }
    }

    if (kothiId && Number.isInteger(kothiId)) {
      const kothiResult = await pool.query(
        `SELECT w.ward_id, w.zone_id, w.sector_id, z.city_id
         FROM wards w
         JOIN zones z ON z.zone_id = w.zone_id
         WHERE w.ward_id = $1
         LIMIT 1`,
        [kothiId]
      );
      const kothiRow = kothiResult.rows[0];
      if (!kothiRow) {
        return res.status(400).json({ success: false, message: "Selected kothi is invalid." });
      }
      if (Number(kothiRow.city_id) !== cityId) {
        return res.status(400).json({ success: false, message: "Selected kothi does not belong to selected city." });
      }
      if (zoneId && Number(kothiRow.zone_id) !== zoneId) {
        return res.status(400).json({ success: false, message: "Selected kothi does not belong to selected zone." });
      }
      if (wardId && Number(kothiRow.sector_id || 0) !== wardId) {
        return res.status(400).json({ success: false, message: "Selected kothi does not belong to selected ward." });
      }
      if (!zoneId) {
        zoneId = Number(kothiRow.zone_id);
      }
      if (!wardId && Number.isInteger(Number(kothiRow.sector_id))) {
        wardId = Number(kothiRow.sector_id);
      }
    }

    const actorNameResult = await pool.query(
      `SELECT name FROM users WHERE user_id = $1 LIMIT 1`,
      [actorUserId]
    );
    const actorName = actorNameResult.rows[0]?.name || null;

    const insertQuery = `
      INSERT INTO professional_holidays (
        holiday_date,
        holiday_name,
        description,
        city_id,
        zone_id,
        ward_id,
        kothi_id,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      RETURNING id
    `;

    const result = await pool.query(insertQuery, [
      holiday_date,
      cleanName,
      description ? String(description).trim() : null,
      cityId,
      Number.isInteger(zoneId) ? zoneId : null,
      Number.isInteger(wardId) ? wardId : null,
      Number.isInteger(kothiId) ? kothiId : null,
      actorUserId,
    ]);

    await pool.query(
      `INSERT INTO professional_holiday_logs (
        holiday_id, action, actor_user_id, actor_name,
        holiday_date, holiday_name, description,
        city_id, zone_id, ward_id, kothi_id
      )
      VALUES ($1, 'created', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        result.rows[0]?.id || null,
        actorUserId,
        actorName,
        holiday_date,
        cleanName,
        description ? String(description).trim() : null,
        cityId,
        Number.isInteger(zoneId) ? zoneId : null,
        Number.isInteger(wardId) ? wardId : null,
        Number.isInteger(kothiId) ? kothiId : null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Holiday created successfully.",
      data: { id: result.rows[0]?.id || null },
    });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "Holiday already exists for selected date and scope.",
      });
    }
    logger.error("[ProfessionalLeaveMgmt] createHoliday error:", error);
    return res.status(500).json({ success: false, message: "Unable to create holiday." });
  }
};

const deleteHoliday = async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ success: false, message: "Holiday id is required." });
  }
  const requesterRole = String(req.user?.role || "").toLowerCase();
  if (requesterRole !== "admin") {
    return res.status(403).json({ success: false, message: "Only admin can delete declared holidays." });
  }

  try {
    await ensureProfessionalLeaveSchema();

    const holidayResult = await pool.query(
      `SELECT id, city_id FROM professional_holidays WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (holidayResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Holiday not found." });
    }
    if (!hasCityAccess(req, holidayResult.rows[0].city_id)) {
      return res.status(403).json({ success: false, message: "No access to selected city." });
    }

    const actorUserId = req.user?.user_id || req.user?.id || req.user?.userId || null;
    const actorNameResult = actorUserId
      ? await pool.query(`SELECT name FROM users WHERE user_id = $1 LIMIT 1`, [actorUserId])
      : { rows: [] };
    const actorName = actorNameResult.rows[0]?.name || null;
    const detailResult = await pool.query(
      `SELECT holiday_date, holiday_name, description, city_id, zone_id, ward_id, kothi_id
       FROM professional_holidays
       WHERE id = $1`,
      [id]
    );

    await pool.query(`DELETE FROM professional_holidays WHERE id = $1`, [id]);

    const row = detailResult.rows[0];
    if (row) {
      await pool.query(
        `INSERT INTO professional_holiday_logs (
          holiday_id, action, actor_user_id, actor_name,
          holiday_date, holiday_name, description,
          city_id, zone_id, ward_id, kothi_id
        )
        VALUES ($1, 'deleted', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          actorUserId,
          actorName,
          row.holiday_date,
          row.holiday_name,
          row.description,
          row.city_id,
          row.zone_id,
          row.ward_id,
          row.kothi_id,
        ]
      );
    }
    return res.json({ success: true, message: "Holiday deleted successfully." });
  } catch (error) {
    logger.error("[ProfessionalLeaveMgmt] deleteHoliday error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete holiday." });
  }
};

const getHolidayLogs = async (req, res) => {
  const {
    month,
    city_id,
    zone_id,
    ward_id,
    kothi_id,
    page = 1,
    limit = 50,
  } = req.query;

  const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const offset = (normalizedPage - 1) * normalizedLimit;

  try {
    await ensureProfessionalLeaveSchema();
    const holidayScope = await resolveHolidayAccessScope(req);

    const scope = req.cityScope || { all: false, ids: [] };
    const params = [];
    let filters = "WHERE 1=1";

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [yyyy, mm] = month.split("-");
      params.push(yyyy, mm);
      filters += ` AND EXTRACT(YEAR FROM l.holiday_date) = $${params.length - 1} AND EXTRACT(MONTH FROM l.holiday_date) = $${params.length}`;
    }

    if (city_id) {
      if (!hasCityAccess(req, city_id)) {
        return res.status(403).json({ success: false, message: "No access to selected city." });
      }
      params.push(Number(city_id));
      filters += ` AND l.city_id = $${params.length}`;
    } else if (!scope.all) {
      if (!Array.isArray(scope.ids) || scope.ids.length === 0) {
        return res.json({
          success: true,
          data: [],
          pagination: { page: normalizedPage, limit: normalizedLimit, total: 0, pages: 1 },
        });
      }
      params.push(scope.ids);
      filters += ` AND l.city_id = ANY($${params.length}::int[])`;
    }

    if (zone_id) {
      const requestedZoneId = Number(zone_id);
      if (
        !holidayScope.isAdmin &&
        Number.isInteger(requestedZoneId) &&
        holidayScope.zoneIds.length > 0 &&
        !holidayScope.zoneIds.includes(requestedZoneId)
      ) {
        return res.status(403).json({ success: false, message: "No access to selected zone." });
      }
      params.push(Number(zone_id));
      filters += ` AND l.zone_id = $${params.length}`;
    }
    if (ward_id) {
      const requestedWardId = Number(ward_id);
      if (
        !holidayScope.isAdmin &&
        Number.isInteger(requestedWardId) &&
        holidayScope.sectorIds.length > 0 &&
        !holidayScope.sectorIds.includes(requestedWardId)
      ) {
        return res.status(403).json({ success: false, message: "No access to selected ward." });
      }
      params.push(Number(ward_id));
      filters += ` AND l.ward_id = $${params.length}`;
    }
    if (kothi_id) {
      const requestedKothiId = Number(kothi_id);
      if (
        !holidayScope.isAdmin &&
        Number.isInteger(requestedKothiId) &&
        holidayScope.kothiIds.length > 0 &&
        !holidayScope.kothiIds.includes(requestedKothiId)
      ) {
        return res.status(403).json({ success: false, message: "No access to selected kothi." });
      }
      params.push(Number(kothi_id));
      filters += ` AND l.kothi_id = $${params.length}`;
    }

    if (!holidayScope.isAdmin) {
      if (
        holidayScope.zoneIds.length === 0 &&
        holidayScope.sectorIds.length === 0 &&
        holidayScope.kothiIds.length === 0
      ) {
        return res.json({
          success: true,
          data: [],
          pagination: { page: normalizedPage, limit: normalizedLimit, total: 0, pages: 1 },
        });
      }

      const scopeClauses = ["(l.kothi_id IS NULL AND l.ward_id IS NULL AND l.zone_id IS NULL)"];
      if (holidayScope.kothiIds.length > 0) {
        params.push(holidayScope.kothiIds);
        scopeClauses.push(`(l.kothi_id IS NOT NULL AND l.kothi_id = ANY($${params.length}::int[]))`);
      }
      if (holidayScope.sectorIds.length > 0) {
        params.push(holidayScope.sectorIds);
        scopeClauses.push(`(l.kothi_id IS NULL AND l.ward_id IS NOT NULL AND l.ward_id = ANY($${params.length}::int[]))`);
      }
      if (holidayScope.zoneIds.length > 0) {
        params.push(holidayScope.zoneIds);
        scopeClauses.push(`(l.kothi_id IS NULL AND l.ward_id IS NULL AND l.zone_id IS NOT NULL AND l.zone_id = ANY($${params.length}::int[]))`);
      }
      filters += ` AND (${scopeClauses.join(" OR ")})`;
    }

    const dataQuery = `
      SELECT
        l.id,
        l.holiday_id,
        l.action,
        l.actor_user_id,
        l.actor_name,
        l.holiday_date,
        l.holiday_name,
        l.description,
        l.city_id,
        c.city_name,
        l.zone_id,
        z.zone_name,
        l.ward_id,
        sec.sector_name AS ward_name,
        l.kothi_id,
        wk.ward_name AS kothi_name,
        l.created_at
      FROM professional_holiday_logs l
      LEFT JOIN cities c ON c.city_id = l.city_id
      LEFT JOIN zones z ON z.zone_id = l.zone_id
      LEFT JOIN sectors sec ON sec.sector_id = l.ward_id
      LEFT JOIN wards wk ON wk.ward_id = l.kothi_id
      ${filters}
      ORDER BY l.created_at DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM professional_holiday_logs l
      ${filters}
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, [...params, normalizedLimit, offset]),
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
    logger.error("[ProfessionalLeaveMgmt] getHolidayLogs error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch holiday logs." });
  }
};

module.exports = {
  getLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  getHolidayCalendar,
  createHoliday,
  deleteHoliday,
  getHolidayLogs,
};
