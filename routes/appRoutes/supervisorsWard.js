const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const authenticate = require("../../middleware/authenticate");
const { buildPublicFaceUrl } = require("../../utils/faceImage");

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

const mapRowsToWards = (rows) => {
  const wardMap = {};

  rows.forEach((row) => {
    const wardId = row.ward_id;

    if (!wardMap[wardId]) {
      wardMap[wardId] = {
        ward_id: row.ward_id,
        ward_name: row.ward_name,
        city: row.city_name,
        zone: row.zone_name,
        employees: [],
      };
    }

    const faceImageUrl = buildPublicFaceUrl(row.face_embedding);
    const faceEnrolled = Boolean(row.face_embedding);
    const faceConfidence =
      row.face_confidence !== undefined && row.face_confidence !== null
        ? Number(row.face_confidence)
        : null;

    wardMap[wardId].employees.push({
      emp_id: row.emp_id,
      emp_name: row.employee_name,
      emp_code: row.emp_code,
      phone: row.phone,
      designation: row.designation_name,
      department: row.department_name,
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

const fetchSupervisorSummary = async (userId, startDate, endDate) => {
  const summaryQuery = `
    WITH assigned_employees AS (
      SELECT e.emp_id
      FROM employee e
      JOIN supervisor_ward sw ON e.ward_id = sw.ward_id
      WHERE sw.supervisor_id = $1
    ),
    attendance_status AS (
      SELECT
        ae.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
        MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out
      FROM assigned_employees ae
      LEFT JOIN attendance a
        ON a.emp_id = ae.emp_id
       AND a.date::date BETWEEN $2::date AND $3::date
      GROUP BY ae.emp_id
    )
    SELECT
      (SELECT COUNT(*) FROM assigned_employees) AS total_employees,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 AND has_punch_out = 0 THEN 1 ELSE 0 END), 0) AS in_progress,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 AND has_punch_out = 1 THEN 1 ELSE 0 END), 0) AS marked,
      GREATEST(
        (SELECT COUNT(*) FROM assigned_employees) -
        COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0),
        0
      ) AS not_marked
    FROM attendance_status
  `;

  const result = await pool.query(summaryQuery, [userId, startDate, endDate]);
  const summary = result.rows[0] || {};

  const totalEmployees = Number(summary.total_employees) || 0;
  const inProgress = Number(summary.in_progress) || 0;
  const marked = Number(summary.marked) || 0;
  const notMarked = Number(summary.not_marked) || 0;
  const attendanceRate =
    totalEmployees > 0
      ? Number((((inProgress + marked) / totalEmployees) * 100).toFixed(1))
      : 0;

  return {
    totalEmployees,
    inProgress,
    marked,
    notMarked,
    attendanceRate,
  };
};

const fetchSupervisorEmployees = async (userId, startDate, endDate) => {
  const query = `
    SELECT
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
      e.face_embedding,
      e.face_confidence,
      e.face_id,
      CASE
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
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
    JOIN users u ON sw.supervisor_id = u.user_id
    JOIN designation d ON e.designation_id = d.designation_id
    JOIN department dept ON d.department_id = dept.department_id
    LEFT JOIN (
      SELECT
        a.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
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
    ) summary ON summary.emp_id = e.emp_id
    WHERE u.user_id = $1
    ORDER BY w.ward_id, e.name;
  `;

  const result = await pool.query(query, [userId, startDate, endDate]);
  return mapRowsToWards(result.rows);
};

// Summary endpoint for mobile (GET with authentication)
router.get("/summary", authenticate, async (req, res) => {
  const user_id = req.user.user_id;

  if (!user_id) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const { startDate: startDateRaw, endDate: endDateRaw } = req.query;
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const summary = await fetchSupervisorSummary(user_id, startDate, endDate);

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching supervisor summary: ", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// GET endpoint for mobile app (uses JWT token)
router.get("/", authenticate, async (req, res) => {
  const user_id = req.user.user_id;

  if (!user_id) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const { startDate: startDateRaw, endDate: endDateRaw } = req.query;
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const response = await fetchSupervisorEmployees(user_id, startDate, endDate);

    res.json({ success: true, data: response });
  } catch (error) {
    console.error("Error fetching employee data: ", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// Summary endpoint for web compatibility (POST with explicit user_id)
router.post("/summary", async (req, res) => {
  const { user_id, startDate: startDateRaw, endDate: endDateRaw } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const summary = await fetchSupervisorSummary(user_id, startDate, endDate);

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching supervisor summary: ", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

// POST endpoint for web app (backward compatibility)
router.post("/", async (req, res) => {
  const { user_id, startDate: startDateRaw, endDate: endDateRaw } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const { startDate, endDate } = resolveDateRange(startDateRaw, endDateRaw);
    const response = await fetchSupervisorEmployees(user_id, startDate, endDate);

    res.json({ success: true, data: response });
  } catch (error) {
    console.error("Error fetching employee data: ", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

module.exports = router;
