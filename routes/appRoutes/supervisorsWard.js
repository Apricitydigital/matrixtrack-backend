const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const authenticate = require("../../middleware/authMiddleware");
const { authorize } = require("../../middleware/permissionMiddleware");
const { attachCityScope, requireCityScope } = require("../../middleware/cityScope");
const { attachZoneScope } = require("../../middleware/zoneScope");
const { attachKothiScope } = require("../../middleware/kothiScope");
const { buildPublicFaceUrl } = require("../../utils/faceImage");
const { isBackblazeUrl } = require("../../utils/backblaze");
const { ensureSelfAttendanceSupport } = require("../../utils/selfAttendance");
const fs = require("fs");

const logError = (label, error) => {
  try {
    const line = `[${new Date().toISOString()}] ${label}: ${
      error?.stack || error?.message || error
    }\n`;
    fs.appendFileSync("supervisor_errors.log", line);
  } catch (_) {
    // ignore logging failures
  }
};

ensureSelfAttendanceSupport().catch((error) => {
  console.warn(
    "Self attendance bootstrap skipped (supervisor wards):",
    error?.message || error
  );
});

const normalizeUserIdInput = (value) => {
  if (value === undefined || value === null) {
    return { userId: null, valid: true };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { userId: null, valid: true };
    }

    if (trimmed.toUpperCase() === "ALL") {
      return { userId: null, valid: true };
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return { userId: parsed, valid: true };
    }

    return { userId: null, valid: false };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return { userId: value, valid: true };
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return { userId: parsed, valid: true };
  }

  return { userId: null, valid: false };
};

const normalizeCityIdInput = (value) => {
  if (value === undefined || value === null || value === "") {
    return { cityId: null, valid: true };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return { cityId: null, valid: true };
    }

    if (trimmed.toUpperCase() === "ALL") {
      return { cityId: null, valid: true };
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return { cityId: parsed, valid: true };
    }

    return { cityId: null, valid: false };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return { cityId: value, valid: true };
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return { cityId: parsed, valid: true };
  }

  return { cityId: null, valid: false };
};

const enforceCityScope = (req, requestedCityId) => {
  const scope = req.cityScope || { all: false, ids: [] };
  if (scope.all) {
    return { cityId: requestedCityId ?? null, allowed: true };
  }

  const allowedCityIds = (scope.ids || [])
    .map((cityId) => Number(cityId))
    .filter((cityId) => Number.isFinite(cityId));

  // If no explicit city scope, allow request to proceed with null city (will yield empty data downstream).
  if (!allowedCityIds.length) {
    return { cityId: requestedCityId ?? null, allowed: true };
  }

  if (requestedCityId === null || requestedCityId === undefined) {
    return { cityId: allowedCityIds[0], allowed: true };
  }

  const numeric = Number(requestedCityId);
  if (!Number.isFinite(numeric)) {
    return { cityId: null, allowed: false };
  }

  return { cityId: numeric, allowed: allowedCityIds.includes(numeric) };
};

const resolveZoneScope = (req) => {
  const scope = req.zoneScope || { all: true, ids: [] };
  if (scope.all) {
    return [];
  }

  const allowedZoneIds = Array.isArray(scope.ids)
    ? scope.ids
      .map((zoneId) => Number(zoneId))
      .filter((zoneId) => Number.isFinite(zoneId))
    : [];

  return allowedZoneIds.length > 0 ? allowedZoneIds : [];
};

const resolveKothiScope = (req) => {
  const scope = req.kothiScope || { all: true, ids: [] };
  if (scope.all) {
    return [];
  }
  const ids = Array.isArray(scope.ids)
    ? scope.ids
        .map((wardId) => Number(wardId))
        .filter((wardId) => Number.isFinite(wardId))
    : [];
  return ids.length > 0 ? ids : [];
};

const parseIdList = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
  }
  return [];
};

const resolveDateRange = (rawStart, rawEnd) => {
  const todayIso = new Date().toISOString().split("T")[0];
  const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

  const normalizeInputDate = (value, fallbackIso) => {
    if (!value) {
      return fallbackIso;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (ISO_DATE_PATTERN.test(trimmed)) {
        return trimmed;
      }

      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString().split("T")[0];
      }
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().split("T")[0];
    }

    return fallbackIso;
  };

  const startIso = normalizeInputDate(rawStart, todayIso);
  const endIso = normalizeInputDate(rawEnd, todayIso);

  if (startIso <= endIso) {
    return { startDate: startIso, endDate: endIso };
  }

  return { startDate: endIso, endDate: startIso };
};

const mapRowsToWards = (rows, supervisorUserId = null) => {
  const wardMap = {};

  rows.forEach((row) => {
    const wardId = row.ward_id;

    if (!wardMap[wardId]) {
      wardMap[wardId] = {
        ward_id: row.ward_id,
        ward_name: row.ward_name,
        city: row.city_name,
        zone: row.zone_name,
        // ✅ Stamp supervisor_id on the ward too so the mobile app's
        //    isEmployeeAssignedToSupervisor & enforceSupervisorIntegrity can
        //    verify ownership when the employee object lacks the field.
        supervisor_id: supervisorUserId ?? null,
        supervisorId: supervisorUserId ?? null,
        employees: [],
      };
    }

    // Only attach a face image URL when we know an embedding/key exists.
    let faceImageUrl = null;
    if (row.face_embedding) {
      faceImageUrl = row.emp_id
        ? `app/attendance/employee/faceRoutes/image/${row.emp_id}`
        : buildPublicFaceUrl(row.face_embedding);

      if (!faceImageUrl && typeof row.face_embedding === "string") {
        faceImageUrl = row.face_embedding;
      }
    }
    const faceEnrolled = Boolean(row.face_embedding);
    const faceConfidence =
      row.face_confidence !== undefined && row.face_confidence !== null
        ? Number(row.face_confidence)
        : null;

    const supervisorIdStr =
      supervisorUserId !== null && supervisorUserId !== undefined
        ? String(supervisorUserId)
        : null;

    wardMap[wardId].employees.push({
      emp_id: row.emp_id,
      emp_name: row.employee_name,
      emp_code: row.emp_code,
      phone: row.phone,
      designation: row.designation_name,
      department: row.department_name,
      supervisor_name: row.supervisor_name,
      // ✅ Supervisor ID fields — required by mobile app's integrity check
      //    (enforceSupervisorIntegrity in DashboardScreen.js). Without these,
      //    getSupervisorIdentifiers returns [] → MISSING_EMPLOYEE_SUPERVISOR error.
      supervisor_id: supervisorIdStr,
      supervisorId: supervisorIdStr,
      assigned_supervisor_id: supervisorIdStr,
      assignedSupervisorId: supervisorIdStr,
      ward_supervisor_id: supervisorIdStr,
      wardSupervisorId: supervisorIdStr,
      attendance_status: row.attendance_status,
      days_present: Number(row.days_present ?? 0),
      days_marked: Number(row.days_marked ?? 0),
      face_embedding: row.face_embedding,
      face_id: row.face_id,
      faceId: row.face_id,
      face_confidence: faceConfidence,
      faceConfidence: faceConfidence,
      face_image_url: faceImageUrl,
      faceImageUrl: faceImageUrl,
      faceEnrollmentUrl: faceImageUrl,
      face_enrolled: faceEnrolled,
      faceEnrolled: faceEnrolled,
      face_registered: faceEnrolled,
      faceRegistered: faceEnrolled,
      self_attendance_enabled: Boolean(row.self_attendance_enabled),
      selfAttendanceEnabled: Boolean(row.self_attendance_enabled),
      punch_in_time: row.punch_in_time,
      punch_out_time: row.punch_out_time,
      last_punch_time: row.last_punch_time,
      punch_in_display: row.punch_in_display,
      punch_out_display: row.punch_out_display,
      last_punch_display: row.last_punch_display,
      has_punch_in: Boolean(row.has_punch_in),
      has_punch_out: Boolean(row.has_punch_out),
      punch_in_epoch: row.punch_in_epoch
        ? Number(row.punch_in_epoch)
        : null,
      punch_out_epoch: row.punch_out_epoch
        ? Number(row.punch_out_epoch)
        : null,
      last_punch_epoch: row.last_punch_epoch
        ? Number(row.last_punch_epoch)
        : null,
    });
  });

  return Object.values(wardMap);
};

const EMPTY_SUMMARY = {
  totalEmployees: 0,
  present: 0,
  marked: 0,
  fullyMarked: 0,
  inProgress: 0,
  onLeave: 0,
  notMarked: 0,
  attendanceRate: 0,
};

const fetchSupervisorSummary = async (
  userId,
  cityId,
  startDate,
  endDate,
  options = {}
) => {
  const { zoneIds = [], kothiIds = [] } = options;
  const hasZoneFilter = Array.isArray(zoneIds) && zoneIds.length > 0;
  const hasKothiFilter = Array.isArray(kothiIds) && kothiIds.length > 0;

  const baseFilters = [];
  const params = [];

  if (cityId) {
    params.push(cityId);
    baseFilters.push(`c.city_id = $${params.length}`);
  }

  if (userId) {
    // Fallback to user-linked wards/zones to avoid city-wide expansion
    params.push(userId);
    const userParam = params.length;
    baseFilters.push(
      `(sw.supervisor_id = $${userParam} OR
        w.ward_id IN (SELECT ward_id FROM user_kothi_access WHERE user_id = $${userParam}) OR
        w.ward_id IN (SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $${userParam}) OR
        w.zone_id IN (SELECT zone_id FROM user_zone_access WHERE user_id = $${userParam}))`
    );
  }

  if (hasZoneFilter) {
    params.push(zoneIds);
    baseFilters.push(`z.zone_id = ANY($${params.length}::int[])`);
  }

  if (hasKothiFilter) {
    params.push(kothiIds);
    baseFilters.push(`w.ward_id = ANY($${params.length}::int[])`);
  }

  const startParam = params.length + 1;
  const endParam = params.length + 2;

  const whereClause =
    baseFilters.length > 0 ? `WHERE ${baseFilters.join(" AND ")}` : "";

  const summaryQuery = `
    WITH scoped_employees AS (
      SELECT DISTINCT e.emp_id
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
      ${whereClause}
    ),
    attendance_status AS (
      SELECT
        se.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
        MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
        MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out
      FROM scoped_employees se
      LEFT JOIN attendance a
        ON a.emp_id = se.emp_id
       AND a.date::date BETWEEN $${startParam}::date AND $${endParam}::date
      GROUP BY se.emp_id
    )
    SELECT
      (SELECT COUNT(*) FROM scoped_employees) AS total_employees,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) AS present,
      COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0) AS on_leave,
      COALESCE(SUM(CASE WHEN has_punch_out = 1 THEN 1 ELSE 0 END), 0) AS fully_marked,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 AND has_punch_out = 0 THEN 1 ELSE 0 END), 0) AS in_progress,
      GREATEST(
        (SELECT COUNT(*) FROM scoped_employees) -
        COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0),
        0
      ) AS not_marked
    FROM attendance_status;
  `;

  params.push(startDate, endDate);
  const result = await pool.query(summaryQuery, params);
  const row = result.rows[0] || {};
  const totalEmployees = Number(row.total_employees) || 0;
  const present = Number(row.present) || 0;
  const onLeave = Number(row.on_leave) || 0;
  const fullyMarked = Number(row.fully_marked) || 0;
  const inProgress = Number(row.in_progress) || 0;
  const notMarked = Number(row.not_marked) || 0;
  const attendanceRate =
    totalEmployees > 0
      ? Number((((present + onLeave) / totalEmployees) * 100).toFixed(1))
      : 0;

  return {
    totalEmployees,
    present,
    marked: present,
    fullyMarked,
    inProgress,
    onLeave,
    notMarked,
    attendanceRate,
  };
};

const fetchSupervisorEmployees = async (
  userId,
  cityId,
  startDate,
  endDate,
  options = {}
) => {
  const { zoneIds = [], kothiIds = [], allowCityFallback = false } = options;
  const hasZoneFilter = Array.isArray(zoneIds) && zoneIds.length > 0;
  const hasKothiFilter = Array.isArray(kothiIds) && kothiIds.length > 0;
  await ensureSelfAttendanceSupport();
  const params = [userId ?? null, startDate, endDate, cityId ?? null];
  
  let accessFilter = "TRUE";
  // Only restrict if we're not allowing city fallback and no specific filters are applied
  if (!allowCityFallback && userId) {
    accessFilter = `($1::int IS NULL OR sw_exists.is_assigned OR kothi_rbac.is_assigned OR sup_kothi_rbac.is_assigned OR zone_rbac.is_assigned)`;
  }
  
  const queryParts = [
    `SELECT DISTINCT ON (e.emp_id)
      e.emp_id,
      e.name AS employee_name,
      e.emp_code,
      e.phone,
      w.ward_id,
      w.ward_name,
      z.zone_id,
      z.zone_name,
      c.city_id,
      c.city_name,
      d.designation_name,
      dept.department_name,
      (
        SELECT STRING_AGG(su.name, ', ')
        FROM supervisor_ward sw2
        JOIN users su ON sw2.supervisor_id = su.user_id
        WHERE sw2.ward_id = e.ward_id
      ) AS supervisor_name,
      e.face_embedding,
      e.face_confidence,
      e.face_id,
      e.self_attendance_enabled,
      CASE
          WHEN COALESCE(summary.has_leave, 0) = 1 THEN 'Leave'
          WHEN COALESCE(summary.has_punch_in, 0) = 0 THEN 'Not Marked'
          WHEN COALESCE(summary.has_punch_out, 0) = 1 THEN 'Marked'
          ELSE 'In Progress'
      END AS attendance_status,
      COALESCE(summary.days_present, 0) AS days_present,
      COALESCE(summary.days_marked, 0) AS days_marked,
      summary.has_punch_in,
      summary.has_punch_out,
      summary.last_punch_time,
      summary.punch_in_time,
      summary.punch_out_time,
      summary.punch_in_display,
      summary.punch_out_display,
      summary.last_punch_display,
      summary.punch_in_epoch,
      summary.punch_out_epoch,
      summary.last_punch_epoch
    FROM employee e
    LEFT JOIN wards w ON e.ward_id = w.ward_id
    LEFT JOIN zones z ON w.zone_id = z.zone_id
    LEFT JOIN cities c ON z.city_id = c.city_id
    LEFT JOIN designation d ON e.designation_id = d.designation_id
    LEFT JOIN department dept ON d.department_id = dept.department_id
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM supervisor_ward sw WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $1) AS is_assigned) sw_exists ON TRUE
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM user_kothi_access uk WHERE uk.ward_id = e.ward_id AND uk.user_id = $1) AS is_assigned) kothi_rbac ON TRUE
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM supervisor_kothi sk WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $1) AS is_assigned) sup_kothi_rbac ON TRUE
    -- zone access should be checked against the employee's ward's zone, not a non-existent e.zone_id
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM user_zone_access uz WHERE uz.zone_id = w.zone_id AND uz.user_id = $1) AS is_assigned) zone_rbac ON TRUE
    LEFT JOIN (
      SELECT  
        a.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
        MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
        MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out,
        COUNT(*) FILTER (WHERE a.punch_in_time IS NOT NULL) AS days_present,
        COUNT(*) FILTER (WHERE a.punch_out_time IS NOT NULL) AS days_marked,
        MAX(a.punch_in_time) FILTER (WHERE a.punch_in_time IS NOT NULL) AS punch_in_time,
        MAX(a.punch_out_time) FILTER (WHERE a.punch_out_time IS NOT NULL) AS punch_out_time,
        MAX(
          CASE
            WHEN a.punch_out_time IS NOT NULL THEN a.punch_out_time
            WHEN a.punch_in_time IS NOT NULL THEN a.punch_in_time
            ELSE NULL
          END
        ) AS last_punch_time,
        TO_CHAR((MAX(a.punch_in_time) AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS punch_in_display,
        TO_CHAR((MAX(a.punch_out_time) AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS punch_out_display,
        TO_CHAR((
          MAX(
            CASE
              WHEN a.punch_out_time IS NOT NULL THEN a.punch_out_time
              WHEN a.punch_in_time IS NOT NULL THEN a.punch_in_time
              ELSE NULL
            END
          ) AT TIME ZONE 'Asia/Kolkata'
        ), 'HH12:MI AM') AS last_punch_display,
        EXTRACT(EPOCH FROM MAX(a.punch_in_time)) AS punch_in_epoch,
        EXTRACT(EPOCH FROM MAX(a.punch_out_time)) AS punch_out_epoch,
        EXTRACT(EPOCH FROM MAX(
          CASE
            WHEN a.punch_out_time IS NOT NULL THEN a.punch_out_time
            WHEN a.punch_in_time IS NOT NULL THEN a.punch_in_time
            ELSE NULL
          END
        )) AS last_punch_epoch
      FROM attendance a
      WHERE a.date::date BETWEEN $2::date AND $3::date
      GROUP BY a.emp_id
    ) summary ON summary.emp_id = e.emp_id`
  ];

  let whereClauses = [`($4::int IS NULL OR c.city_id = $4::int)`];
  
  if (hasZoneFilter) {
    params.push(zoneIds);
    whereClauses.push(`z.zone_id = ANY($${params.length}::int[])`);
  }
  
  if (hasKothiFilter) {
    params.push(kothiIds);
    whereClauses.push(`w.ward_id = ANY($${params.length}::int[])`);
  }

  const query = `
    ${queryParts[0]}
    WHERE ${accessFilter}
      AND ${whereClauses.join(' AND ')}
    ORDER BY e.emp_id, w.ward_id, e.name;
  `;

  const result = await pool.query(query, params);
  const rows = result.rows;
  console.log(`[DEBUG] fetchSupervisorEmployees: returned ${rows.length} rows for user ${userId} in city ${cityId}`);

  // Pass userId so mapRowsToWards can stamp supervisor_id on every employee record.
  // This is required by the mobile app's enforceSupervisorIntegrity check.
  return mapRowsToWards(rows, userId);
};

const fetchCitySummary = async (
  userId,
  cityId,
  startDate,
  endDate,
  zoneIds = []
) => {
  const hasZoneFilter = Array.isArray(zoneIds) && zoneIds.length > 0;
  const query = `
    WITH employee_city AS (
      SELECT DISTINCT
        e.emp_id,
        c.city_id,
        c.city_name
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN supervisor_ward sw ON e.ward_id = sw.ward_id
      WHERE ($1::int IS NULL OR 
             sw.supervisor_id = $1::int OR 
             w.ward_id IN (SELECT ward_id FROM user_kothi_access WHERE user_id = $1) OR
             w.ward_id IN (SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1) OR
             w.zone_id IN (SELECT zone_id FROM user_zone_access WHERE user_id = $1)
            )
        AND ($4::int IS NULL OR c.city_id = $4::int)
        ${hasZoneFilter ? "AND z.zone_id = ANY($5::int[])" : ""}
    ),
    attendance_status AS (
      SELECT
        ec.city_id,
        ec.city_name,
        ec.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
        MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
        MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out
      FROM employee_city ec
      LEFT JOIN attendance a
        ON a.emp_id = ec.emp_id
       AND a.date::date BETWEEN $2::date AND $3::date
      GROUP BY ec.city_id, ec.city_name, ec.emp_id
    )
    SELECT
      city_id,
      city_name,
      COUNT(*) AS total_employees,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) AS present,
      COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0) AS on_leave,
      COALESCE(SUM(CASE WHEN has_punch_out = 1 THEN 1 ELSE 0 END), 0) AS fully_marked,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 AND has_punch_out = 0 THEN 1 ELSE 0 END), 0) AS in_progress,
      COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0) AS on_leave_only,
      GREATEST(
        COUNT(*) -
        COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0),
        0
      ) AS not_marked
    FROM attendance_status
    GROUP BY city_id, city_name
    ORDER BY city_name;
  `;

  const params = [userId ?? null, startDate, endDate, cityId ?? null];
  if (hasZoneFilter) {
    params.push(zoneIds);
  }

  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    city_id: row.city_id,
    city_name: row.city_name || "Unassigned",
    totalEmployees: Number(row.total_employees) || 0,
    present: Number(row.present) || 0,
    onLeave: Number(row.on_leave) || 0,
    marked: Number(row.present) || 0,
    fullyMarked: Number(row.fully_marked) || 0,
    inProgress: Number(row.in_progress) || 0,
    notMarked: Math.max(
      (Number(row.total_employees) || 0) - (Number(row.present) || 0) - (Number(row.on_leave) || 0),
      0
    ),
  }));
};

const fetchZoneSummary = async (
  userId,
  cityId,
  startDate,
  endDate,
  allowCityFallback = false
) => {
  const cityFallbackClause = allowCityFallback
    ? "OR z.city_id IN (SELECT city_id FROM user_city_access WHERE user_id = $1)"
    : "";
  const query = `
    WITH employee_zone AS (
      SELECT DISTINCT
        e.emp_id,
        z.zone_id,
        z.zone_name
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN supervisor_ward sw ON e.ward_id = sw.ward_id
      WHERE ($1::int IS NULL OR 
             sw.supervisor_id = $1::int OR 
             w.ward_id IN (SELECT ward_id FROM user_kothi_access WHERE user_id = $1) OR
             w.ward_id IN (SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1) OR
             w.zone_id IN (SELECT zone_id FROM user_zone_access WHERE user_id = $1)
             ${cityFallbackClause}
            )
        AND ($4::int IS NULL OR c.city_id = $4::int)
    ),
    attendance_status AS (
      SELECT
        ez.zone_id,
        ez.zone_name,
        ez.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
        MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out,
        MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave
      FROM employee_zone ez
      LEFT JOIN attendance a
        ON a.emp_id = ez.emp_id
       AND a.date::date BETWEEN $2::date AND $3::date
      GROUP BY ez.zone_id, ez.zone_name, ez.emp_id
    )
    SELECT
      zone_id,
      zone_name,
      COUNT(*) AS total_employees,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) AS present,
      COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0) AS on_leave,
      COALESCE(SUM(CASE WHEN has_punch_out = 1 THEN 1 ELSE 0 END), 0) AS fully_marked,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 AND has_punch_out = 0 THEN 1 ELSE 0 END), 0) AS in_progress,
      GREATEST(COUNT(*) - COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0), 0) AS not_marked
    FROM attendance_status
    GROUP BY zone_id, zone_name
    ORDER BY zone_name;
  `;

  const params = [userId ?? null, startDate, endDate, cityId ?? null];
  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    zone_id: row.zone_id,
    zone_name: row.zone_name || "Unassigned",
    totalEmployees: Number(row.total_employees) || 0,
    present: Number(row.present) || 0,
    onLeave: Number(row.on_leave) || 0,
    marked: Number(row.present) || 0,
    fullyMarked: Number(row.fully_marked) || 0,
    inProgress: Number(row.in_progress) || 0,
    notMarked: Math.max(
      (Number(row.total_employees) || 0) -
        (Number(row.present) || 0) -
        (Number(row.on_leave) || 0),
      0
    ),
  }));
};

router.use(
  authenticate,
  attachCityScope,
  // Allow empty city scope to return empty summary instead of 403; admins already bypass inside middleware.
  requireCityScope(false, true),
  attachZoneScope,
  attachKothiScope,
  authorize("dashboard", "view")
);

// Summary endpoint for mobile (GET with authentication)
router.get("/summary", async (req, res) => {
  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? null : requestingUser?.user_id;

  if (!isAdmin && !effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cityId, valid } = normalizeCityIdInput(req.query.city_id);
  if (!valid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for dashboard" });
  }

  const allowedZoneIds = resolveZoneScope(req);
  const allowedKothiIds = resolveKothiScope(req);
  const requestedZoneIds = parseIdList(
    req.query.zoneIds ||
      req.query.zone_ids ||
      req.query.zones ||
      req.query.zoneId ||
      req.query.zone_id
  );
  const requestedKothiIds = parseIdList(
    req.query.kothiIds ||
      req.query.kothi_ids ||
      req.query.wardIds ||
      req.query.ward_ids ||
      req.query.kothiId ||
      req.query.kothi_id ||
      req.query.wardId ||
      req.query.ward_id
  );

  // Use requested filters if provided, otherwise fall back to full allowed scope
  const zoneIds =
    requestedZoneIds.length > 0
      ? requestedZoneIds.filter((id) => allowedZoneIds.includes(id))
      : allowedZoneIds;
  const kothiIds =
    requestedKothiIds.length > 0
      ? requestedKothiIds.filter((id) => allowedKothiIds.includes(id))
      : allowedKothiIds;

  const hasScope = zoneIds.length || kothiIds.length;
  if (!isAdmin && !hasScope) {
    return res.json({ success: true, data: EMPTY_SUMMARY });
  }
  const allowCityFallback = isAdmin; // supervisors should never fall back to city-wide scope

  try {
    const { startDate: startDateRaw, endDate: endDateRaw } = req.query;
    const todayIso = new Date().toISOString().slice(0, 10);
    const { startDate, endDate } = resolveDateRange(
      startDateRaw || todayIso,
      endDateRaw || todayIso
    );
    const summary = await fetchSupervisorSummary(
      effectiveUserId,
      scopedCityId,
      startDate,
      endDate,
      { allowCityFallback, zoneIds, kothiIds }
    );

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching supervisor summary: ", error);
    logError("summary-get", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// GET endpoint for mobile app (uses JWT token)
router.get("/", async (req, res) => {
  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? null : requestingUser?.user_id;

  if (!isAdmin && !effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cityId, valid } = normalizeCityIdInput(req.query.city_id);
  if (!valid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for dashboard" });
  }

  const allowedZoneIds = resolveZoneScope(req);
  const allowedKothiIds = resolveKothiScope(req);
  const allowCityFallback = isAdmin;

  try {
    const { startDate: startDateRaw, endDate: endDateRaw } = req.query;
    const todayIso = new Date().toISOString().slice(0, 10);
    const { startDate, endDate } = resolveDateRange(
      startDateRaw || todayIso,
      endDateRaw || todayIso
    );
    const response = await fetchSupervisorEmployees(
      effectiveUserId,
      scopedCityId,
      startDate,
      endDate,
      { allowCityFallback, zoneIds: allowedZoneIds, kothiIds: allowedKothiIds }
    );

    res.json({ success: true, data: response });
  } catch (error) {
    console.error("Error fetching employee data: ", error);
    logError("wards-get", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Return allowed kothi/ward list for the supervisor (used to populate filters)
router.get("/kothi-list", async (req, res) => {
  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? null : requestingUser?.user_id;

  if (!isAdmin && !effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cityId, valid } = normalizeCityIdInput(req.query.city_id);
  if (!valid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for dashboard" });
  }

  const allowedZoneIds = resolveZoneScope(req);
  const allowedKothiIds = resolveKothiScope(req);
  const zoneFilter =
    allowedZoneIds.length > 0 ? "AND z.zone_id = ANY($2::int[])" : "";
  const kothiFilter =
    allowedKothiIds.length > 0 ? "AND w.ward_id = ANY($3::int[])" : "";

  try {
    const params = [scopedCityId ?? null];
    if (allowedZoneIds.length > 0) params.push(allowedZoneIds);
    if (allowedKothiIds.length > 0) params.push(allowedKothiIds);

    const { rows } = await pool.query(
      `
        SELECT DISTINCT
          w.ward_id,
          w.ward_name,
          z.zone_id,
          z.zone_name,
          c.city_id,
          c.city_name
        FROM wards w
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
        WHERE ($1::int IS NULL OR c.city_id = $1::int)
          ${zoneFilter}
          ${kothiFilter}
        ORDER BY w.ward_name ASC
      `,
      params
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("Error fetching kothi list:", error);
    logError("kothi-list", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

router.post("/city-summary", async (req, res) => {
  const { user_id, city_id, startDate: startDateRaw, endDate: endDateRaw } =
    req.body;
  const { userId, valid } = normalizeUserIdInput(user_id);
  const { cityId, valid: cityValid } = normalizeCityIdInput(city_id);

  if (!valid) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  if (!cityValid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? userId : requestingUser?.user_id;
  if (!isAdmin && !effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for dashboard" });
  }

  const allowedZoneIds = resolveZoneScope(req);

  try {
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const summary = await fetchCitySummary(
      effectiveUserId,
      scopedCityId,
      startDate,
      endDate,
      allowedZoneIds,
      isAdmin
    );

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching city summary: ", error);
    logError("city-summary", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Zone drilldown: attendance breakdown by zone inside a specific city
router.post("/zone-summary", async (req, res) => {
  const { user_id, city_id, startDate: startDateRaw, endDate: endDateRaw } =
    req.body;
  const { userId, valid } = normalizeUserIdInput(user_id);
  const { cityId, valid: cityValid } = normalizeCityIdInput(city_id);

  if (!valid) return res.status(400).json({ error: "Invalid user ID" });
  if (!cityValid) return res.status(400).json({ error: "Invalid city ID" });

  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? userId : requestingUser?.user_id;
  if (!isAdmin && !effectiveUserId)
    return res.status(400).json({ error: "User ID is required" });

  const { cityId: scopedCityId, allowed } = enforceCityScope(req, cityId ?? null);
  if (!allowed)
    return res.status(403).json({ error: "Forbidden: city not permitted" });

  try {
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const summary = await fetchZoneSummary(
      effectiveUserId,
      scopedCityId,
      startDate,
      endDate,
      isAdmin
    );
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching zone summary:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Summary endpoint for web compatibility (POST with explicit user_id)
router.post("/summary", async (req, res) => {
  const { user_id, city_id, startDate: startDateRaw, endDate: endDateRaw } =
    req.body;
  const { userId, valid } = normalizeUserIdInput(user_id);
  const { cityId, valid: cityValid } = normalizeCityIdInput(city_id);

  if (!valid) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  if (!cityValid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? userId : requestingUser?.user_id;
  if (!isAdmin && !effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for dashboard" });
  }

  const allowedZoneIds = resolveZoneScope(req);
  const allowedKothiIds = resolveKothiScope(req);
  const requestedZoneIds = parseIdList(
    req.body?.zoneIds ||
      req.body?.zone_ids ||
      req.body?.zones ||
      req.body?.zoneId ||
      req.body?.zone_id
  );
  const requestedKothiIds = parseIdList(
    req.body?.kothiIds ||
      req.body?.kothi_ids ||
      req.body?.wardIds ||
      req.body?.ward_ids ||
      req.body?.kothiId ||
      req.body?.kothi_id ||
      req.body?.wardId ||
      req.body?.ward_id
  );

  const zoneIds =
    requestedZoneIds.length > 0
      ? requestedZoneIds.filter((id) => allowedZoneIds.includes(id))
      : allowedZoneIds;
  const kothiIds =
    requestedKothiIds.length > 0
      ? requestedKothiIds.filter((id) => allowedKothiIds.includes(id))
      : allowedKothiIds;

  const hasScope = zoneIds.length || kothiIds.length;
  if (!isAdmin && !hasScope) {
    return res.json({ success: true, data: EMPTY_SUMMARY });
  }
  const allowCityFallback = isAdmin; // only admins may expand to city level

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const { startDate, endDate } = resolveDateRange(
      startDateRaw || todayIso,
      endDateRaw || todayIso
    );
    const summary = await fetchSupervisorSummary(
      effectiveUserId,
      scopedCityId,
      startDate,
      endDate,
      { allowCityFallback, zoneIds, kothiIds }
    );

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching supervisor summary: ", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// POST endpoint for web app (backward compatibility)
router.post("/", async (req, res) => {
  const { user_id, city_id, startDate: startDateRaw, endDate: endDateRaw } =
    req.body;
  const { userId, valid } = normalizeUserIdInput(user_id);
  const { cityId, valid: cityValid } = normalizeCityIdInput(city_id);

  if (!valid) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  if (!cityValid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const requestingUser = req.user;
  const isAdmin = requestingUser?.role === "admin";
  const effectiveUserId = isAdmin ? userId : requestingUser?.user_id;
  if (!isAdmin && !effectiveUserId) {
    return res.status(400).json({ error: "User ID is required" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for dashboard" });
  }

  const allowedZoneIds = resolveZoneScope(req);
  const allowedKothiIds = resolveKothiScope(req);

  const requestedZoneIds = parseIdList(
    req.body?.zoneIds ||
      req.body?.zone_ids ||
      req.body?.zones ||
      req.body?.zoneId ||
      req.body?.zone_id
  );
  const requestedKothiIds = parseIdList(
    req.body?.kothiIds ||
      req.body?.kothi_ids ||
      req.body?.wardIds ||
      req.body?.ward_ids ||
      req.body?.kothiId ||
      req.body?.kothi_id ||
      req.body?.wardId ||
      req.body?.ward_id
  );

  const zoneIds =
    requestedZoneIds.length > 0
      ? requestedZoneIds.filter((id) => allowedZoneIds.includes(id))
      : allowedZoneIds;
  const kothiIds =
    requestedKothiIds.length > 0
      ? requestedKothiIds.filter((id) => allowedKothiIds.includes(id))
      : allowedKothiIds;

  // A supervisor can see everything if they have city-wide access (scope.all)
  const isCityWideSupervisor = !isAdmin && (req.cityScope?.all === true);
  const allowCityFallback = isAdmin || isCityWideSupervisor;

  try {
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const response = await fetchSupervisorEmployees(
      effectiveUserId,
      scopedCityId,
      startDate,
      endDate,
      { allowCityFallback, zoneIds, kothiIds }
    );

    res.json({ success: true, data: response });
  } catch (error) {
    console.error("Error fetching employee data: ", error);
    logError("wards-post", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// ── Top Performing Supervisors ─────────────────────────────────────────────
router.post("/top-supervisors", async (req, res) => {
  const { city_id, startDate: startDateRaw, endDate: endDateRaw, zoneIds, kothiIds } = req.body;
  const { cityId, valid: cityValid } = normalizeCityIdInput(city_id);

  if (!cityValid) {
    return res.status(400).json({ error: "Invalid city ID" });
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(req, cityId ?? null);
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted" });
  }

  try {
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);

    const params = [startDate, endDate];
    let extraFilters = "";
    if (scopedCityId !== null && scopedCityId !== undefined) {
      params.push(scopedCityId);
      extraFilters += ` AND c.city_id = $${params.length}`;
    }
    
    if (Array.isArray(zoneIds) && zoneIds.length > 0) {
      params.push(zoneIds);
      extraFilters += ` AND z.zone_id = ANY($${params.length}::int[])`;
    }
    
    if (Array.isArray(kothiIds) && kothiIds.length > 0) {
      params.push(kothiIds);
      extraFilters += ` AND w.ward_id = ANY($${params.length}::int[])`;
    }

    const query = `
      WITH supervisor_employees AS (
        SELECT DISTINCT
          u.user_id       AS supervisor_id,
          u.name          AS supervisor_name,
          u.emp_code      AS supervisor_emp_code,
          e.emp_id
        FROM users u
        JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
        JOIN wards w            ON sw.ward_id = w.ward_id
        JOIN zones z            ON w.zone_id  = z.zone_id
        JOIN cities c           ON z.city_id  = c.city_id
        JOIN employee e         ON e.ward_id  = w.ward_id
        WHERE u.role = 'supervisor'
          ${extraFilters}
      ),
      emp_status AS (
        SELECT
          se.supervisor_id,
          se.supervisor_name,
          se.supervisor_emp_code,
          se.emp_id,
          MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
          MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
          MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out
        FROM supervisor_employees se
        LEFT JOIN attendance a
          ON a.emp_id = se.emp_id
         AND a.date::date BETWEEN $1::date AND $2::date
        GROUP BY se.supervisor_id, se.supervisor_name, se.supervisor_emp_code, se.emp_id
      ),
      supervisor_agg AS (
        SELECT
          supervisor_id,
          supervisor_name,
          supervisor_emp_code,
          COUNT(*) AS total_employees,
          COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) AS present,
          COALESCE(SUM(CASE WHEN has_leave = 1 AND has_punch_in = 0 THEN 1 ELSE 0 END), 0) AS on_leave,
          COALESCE(SUM(CASE WHEN has_punch_out = 1 THEN 1 ELSE 0 END), 0) AS fully_marked,
          COALESCE(SUM(CASE WHEN has_punch_in = 0 AND has_leave = 0 THEN 1 ELSE 0 END), 0) AS absent
        FROM emp_status
        GROUP BY supervisor_id, supervisor_name, supervisor_emp_code
      )
      SELECT
        supervisor_id,
        supervisor_name,
        supervisor_emp_code,
        total_employees,
        present,
        on_leave,
        fully_marked,
        absent,
        CASE
          WHEN total_employees > 0
            THEN LEAST(ROUND(((present + on_leave)::numeric / total_employees) * 100, 1), 100)
          ELSE 0
        END AS attendance_rate
      FROM supervisor_agg
      WHERE total_employees > 0
      ORDER BY attendance_rate DESC, total_employees DESC
      LIMIT 10;
    `;

    const result = await pool.query(query, params);

    const supervisors = result.rows.map((row) => ({
      supervisor_id: row.supervisor_id,
      name: row.supervisor_name,
      emp_code: row.supervisor_emp_code || "",
      total_employees: Number(row.total_employees) || 0,
      present: Number(row.present) || 0,
      on_leave: Number(row.on_leave) || 0,
      fully_marked: Number(row.fully_marked) || 0,
      absent: Number(row.absent) || 0,
      attendance_rate: Number(row.attendance_rate) || 0,
    }));

    res.json({ success: true, data: supervisors });
  } catch (error) {
    console.error("Error fetching top supervisors:", error);
    logError("top-supervisors", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

module.exports = router;
