/**
 * External API Controller
 * READ-ONLY attendance queries for external consumers via API key auth.
 */

const pool = require("../config/db");

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

const paginate = (query) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

const meta = () => ({
  api_version: "v1",
  timestamp: new Date().toISOString(),
});

/**
 * GET /api/v1/external/attendance/daily?date=YYYY-MM-DD
 */
const getDailyAttendance = async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !isIsoDate(date)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_DATE", message: "Provide date in YYYY-MM-DD format." } });
    }

    const { page, limit, offset } = paginate(req.query);
    const params = [date];
    let paramCount = 1;
    let cityFilter = "";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter = ` AND c.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND z.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    if (req.query.ward_id) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.query.ward_id);
    }

    if (req.query.city_id && !req.apiKey.cityId) {
      paramCount++;
      cityFilter += ` AND c.city_id = $${paramCount}`;
      params.push(req.query.city_id);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       JOIN wards w ON a.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE a.date::date = $1 ${cityFilter}`,
      params
    );

    const total = parseInt(countResult.rows[0].total, 10);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT
         e.emp_id, e.name, e.emp_code, e.phone,
         TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
         TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in,
         TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out,
         a.duration,
         a.in_address, a.out_address,
         a.latitude_in, a.longitude_in,
         a.latitude_out, a.longitude_out,
         COALESCE(a.auto_punched_out, false) AS is_auto_punch_out,
         a.leave_type,
         w.ward_name AS ward, z.zone_name AS zone, c.city_name AS city,
         CASE
           WHEN a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL THEN 'Completed'
           WHEN a.punch_in_time IS NOT NULL THEN 'In Progress'
           WHEN a.leave_type IS NOT NULL THEN 'On Leave'
           ELSE 'Absent'
         END AS status
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       JOIN wards w ON a.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE a.date::date = $1 ${cityFilter}
       ORDER BY a.punch_in_time ASC NULLS LAST
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      dataParams
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      meta: meta(),
    });
  } catch (error) {
    console.error("[ExternalAPI] getDailyAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * GET /api/v1/external/attendance/range?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const getAttendanceRange = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || !isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_DATE", message: "Provide from and to in YYYY-MM-DD format." } });
    }
    if (from > to) {
      return res.status(400).json({ success: false, error: { code: "INVALID_RANGE", message: "'from' must be <= 'to'." } });
    }

    // Max 31 days range
    const diffDays = (new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24);
    if (diffDays > 31) {
      return res.status(400).json({ success: false, error: { code: "RANGE_TOO_LARGE", message: "Max date range is 31 days." } });
    }

    const { page, limit, offset } = paginate(req.query);
    const params = [from, to];
    let paramCount = 2;
    let cityFilter = "";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter = ` AND c.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND z.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    if (req.query.city_id && !req.apiKey.cityId) {
      paramCount++;
      cityFilter += ` AND c.city_id = $${paramCount}`;
      params.push(req.query.city_id);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       JOIN wards w ON a.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE a.date::date BETWEEN $1 AND $2 ${cityFilter}`,
      params
    );

    const total = parseInt(countResult.rows[0].total, 10);
    const dataParams = [...params, limit, offset];

    const result = await pool.query(
      `SELECT
         e.emp_id, e.name, e.emp_code, e.phone,
         TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
         TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in,
         TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out,
         a.duration, a.leave_type,
         w.ward_name AS ward, z.zone_name AS zone, c.city_name AS city,
         CASE
           WHEN a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL THEN 'Completed'
           WHEN a.punch_in_time IS NOT NULL THEN 'In Progress'
           WHEN a.leave_type IS NOT NULL THEN 'On Leave'
           ELSE 'Absent'
         END AS status
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       JOIN wards w ON a.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE a.date::date BETWEEN $1 AND $2 ${cityFilter}
       ORDER BY a.date ASC, a.punch_in_time ASC NULLS LAST
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      dataParams
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      meta: meta(),
    });
  } catch (error) {
    console.error("[ExternalAPI] getAttendanceRange error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * GET /api/v1/external/attendance/summary?date=YYYY-MM-DD
 */
const getAttendanceSummary = async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !isIsoDate(date)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_DATE", message: "Provide date in YYYY-MM-DD format." } });
    }

    const params = [date];
    let paramCount = 1;
    let cityFilter = "";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter = ` AND c.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND z.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    const result = await pool.query(
      `SELECT
         c.city_name,
         COUNT(DISTINCT e.emp_id) FILTER (WHERE a.punch_in_time IS NOT NULL) AS total_present,
         COUNT(DISTINCT e.emp_id) FILTER (WHERE a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL) AS total_completed,
         COUNT(DISTINCT e.emp_id) FILTER (WHERE a.punch_in_time IS NOT NULL AND a.punch_out_time IS NULL) AS total_in_progress,
         COUNT(DISTINCT e.emp_id) FILTER (WHERE a.auto_punched_out = true) AS total_auto_punched_out,
         COUNT(DISTINCT e.emp_id) FILTER (WHERE a.leave_type IS NOT NULL AND a.punch_in_time IS NULL) AS total_on_leave
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       JOIN wards w ON a.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE a.date::date = $1 ${cityFilter}
       GROUP BY c.city_name
       ORDER BY c.city_name`,
      params
    );

    res.json({ success: true, data: { date, cities: result.rows }, meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] getAttendanceSummary error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * GET /api/v1/external/attendance/employee/:empId?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const getEmployeeAttendance = async (req, res) => {
  try {
    const { empId } = req.params;
    const { from, to } = req.query;

    if (!empId) {
      return res.status(400).json({ success: false, error: { code: "MISSING_PARAM", message: "Employee ID is required." } });
    }
    if (!from || !to || !isIsoDate(from) || !isIsoDate(to)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_DATE", message: "Provide from and to in YYYY-MM-DD format." } });
    }

    const params = [empId, from, to];
    let paramCount = 3;
    let cityFilter = "";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter = ` AND c.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND z.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    const result = await pool.query(
      `SELECT
         TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
         TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in,
         TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out,
         a.duration, a.leave_type,
         a.in_address, a.out_address,
         COALESCE(a.auto_punched_out, false) AS is_auto_punch_out,
         CASE
           WHEN a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL THEN 'Completed'
           WHEN a.punch_in_time IS NOT NULL THEN 'In Progress'
           WHEN a.leave_type IS NOT NULL THEN 'On Leave'
           ELSE 'Absent'
         END AS status
       FROM attendance a
       JOIN employee e ON a.emp_id = e.emp_id
       JOIN wards w ON a.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE a.emp_id = $1 AND a.date::date BETWEEN $2 AND $3 ${cityFilter}
       ORDER BY a.date ASC`,
      params
    );

    res.json({ success: true, data: result.rows, meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] getEmployeeAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * GET /api/v1/external/employees
 */
const getEmployees = async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query);
    const params = [];
    let paramCount = 0;
    let cityFilter = " WHERE 1=1";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter += ` AND c.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND z.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    if (req.query.city_id && !req.apiKey.cityId) {
      paramCount++;
      cityFilter += ` AND c.city_id = $${paramCount}`;
      params.push(req.query.city_id);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM employee e
       JOIN wards w ON e.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id ${cityFilter}`,
      params
    );

    const total = parseInt(countResult.rows[0].total, 10);
    const dataParams = [...params, limit, offset];

    const result = await pool.query(
      `SELECT e.emp_id, e.name, e.emp_code, e.phone,
              w.ward_name AS ward, z.zone_name AS zone, c.city_name AS city,
              des.designation_name AS designation, dept.department_name AS department
       FROM employee e
       JOIN wards w ON e.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       LEFT JOIN designation des ON e.designation_id = des.designation_id
       LEFT JOIN department dept ON des.department_id = dept.department_id
       ${cityFilter}
       ORDER BY e.name ASC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      dataParams
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      meta: meta(),
    });
  } catch (error) {
    console.error("[ExternalAPI] getEmployees error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * GET /api/v1/external/professional/attendance/daily?date=YYYY-MM-DD
 */
const getProfessionalDailyAttendance = async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !isIsoDate(date)) {
      return res.status(400).json({ success: false, error: { code: "INVALID_DATE", message: "Provide date in YYYY-MM-DD format." } });
    }

    const { page, limit, offset } = paginate(req.query);
    const params = [date];
    let paramCount = 1;
    let cityFilter = "";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter = ` AND pe.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND pe.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND pe.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM professional_attendance pa
       JOIN professional_employees pe ON pa.professional_id = pe.id
       WHERE pa.date = $1 AND pe.is_active = true ${cityFilter}`,
      params
    );

    const total = parseInt(countResult.rows[0].total, 10);
    const dataParams = [...params, limit, offset];

    const result = await pool.query(
      `SELECT
         pe.id AS professional_id, pe.full_name, pe.emp_code, pe.mobile, pe.email,
         TO_CHAR(pa.date, 'YYYY-MM-DD') AS date,
         TO_CHAR(pa.punch_in, 'HH24:MI:SS') AS punch_in,
         TO_CHAR(pa.punch_out, 'HH24:MI:SS') AS punch_out,
         CASE
           WHEN pa.punch_in IS NOT NULL AND pa.punch_out IS NOT NULL
             THEN ROUND(EXTRACT(EPOCH FROM (pa.punch_out - pa.punch_in)) / 3600, 2)
           ELSE NULL
         END AS hours_worked,
         COALESCE(pa.auto_punched_out, false) AS is_auto_punch_out,
         c.city_name, z.zone_name
       FROM professional_attendance pa
       JOIN professional_employees pe ON pa.professional_id = pe.id
       JOIN cities c ON pe.city_id = c.city_id
       JOIN zones z ON pe.zone_id = z.zone_id
       WHERE pa.date = $1 AND pe.is_active = true ${cityFilter}
       ORDER BY pa.punch_in ASC NULLS LAST
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      dataParams
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
      meta: meta(),
    });
  } catch (error) {
    console.error("[ExternalAPI] getProfessionalDailyAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * City-scope guard — ensures the employee/record belongs to the API key's city.
 * Returns null if allowed, or an error response if blocked.
 */
const verifyCityOwnership = async (tableName, idColumn, idValue, cityId, zoneId = null, wardId = null) => {
  if (!cityId && !zoneId && !wardId) return null; // no city/zone/ward restriction on key
  let query;
  let scopeColumns;
  let params = [idValue];
  let paramIdx = 1;

  if (tableName === "attendance") {
    query = `SELECT 1 FROM attendance a JOIN wards w ON a.ward_id = w.ward_id JOIN zones z ON w.zone_id = z.zone_id JOIN cities c ON z.city_id = c.city_id WHERE a.${idColumn} = $1`;
    scopeColumns = { city: "c.city_id", zone: "z.zone_id", ward: "w.ward_id" };
  } else if (tableName === "employee") {
    query = `SELECT 1 FROM employee e JOIN wards w ON e.ward_id = w.ward_id JOIN zones z ON w.zone_id = z.zone_id JOIN cities c ON z.city_id = c.city_id WHERE e.emp_id = $1`;
    scopeColumns = { city: "c.city_id", zone: "z.zone_id", ward: "w.ward_id" };
  } else if (tableName === "professional_attendance") {
    query = `SELECT 1 FROM professional_attendance pa JOIN professional_employees pe ON pa.professional_id = pe.id WHERE pa.${idColumn} = $1`;
    scopeColumns = { city: "pe.city_id", zone: "pe.zone_id", ward: "pe.ward_id" };
  } else if (tableName === "professional_employees") {
    query = `SELECT 1 FROM professional_employees pe WHERE pe.id = $1`;
    scopeColumns = { city: "pe.city_id", zone: "pe.zone_id", ward: "pe.ward_id" };
  } else {
    throw new Error(`Unsupported ownership table: ${tableName}`);
  }

  if (cityId) {
    paramIdx++;
    query += ` AND ${scopeColumns.city} = $${paramIdx}`;
    params.push(cityId);
  }
  if (zoneId) {
    paramIdx++;
    query += ` AND ${scopeColumns.zone} = $${paramIdx}`;
    params.push(zoneId);
  }
  if (wardId) {
    paramIdx++;
    query += ` AND ${scopeColumns.ward} = $${paramIdx}`;
    params.push(wardId);
  }

  query += ` LIMIT 1`;
  const { rows } = await pool.query(query, params);
  if (rows.length === 0) return "FORBIDDEN";
  return null;
};

const verifyWardWithinKeyScope = async (wardId, apiKey) => {
  if (!wardId) return "FORBIDDEN";
  const params = [wardId];
  let scopeFilter = "";

  if (apiKey.cityId) {
    params.push(apiKey.cityId);
    scopeFilter += ` AND z.city_id = $${params.length}`;
  }
  if (apiKey.zoneId) {
    params.push(apiKey.zoneId);
    scopeFilter += ` AND z.zone_id = $${params.length}`;
  }
  if (apiKey.wardId) {
    params.push(apiKey.wardId);
    scopeFilter += ` AND w.ward_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT 1
     FROM wards w
     JOIN zones z ON w.zone_id = z.zone_id
     WHERE w.ward_id = $1${scopeFilter}
     LIMIT 1`,
    params
  );
  return rows.length > 0 ? null : "FORBIDDEN";
};

// ═══════════════════════════════════════════════════════════
//  SUPERVISOR / REGULAR ATTENDANCE — WRITE OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/v1/external/attendance/punch-in
 * Mark punch-in for a regular (supervisor) employee
 */
const markPunchIn = async (req, res) => {
  try {
    const { emp_id, ward_id, date, punch_in_time, latitude, longitude, address } = req.body;
    if (!emp_id || !ward_id) {
      return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "emp_id and ward_id are required." } });
    }
    const targetDate = date && isIsoDate(date) ? date : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    // City ownership check
    const blocked = await verifyCityOwnership("employee", "emp_id", emp_id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Employee does not belong to your assigned city." } });
    const wardBlocked = await verifyWardWithinKeyScope(ward_id, req.apiKey);
    if (wardBlocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "ward_id is outside your assigned scope." } });

    // Check duplicate
    const dup = await pool.query(`SELECT attendance_id FROM attendance WHERE emp_id = $1 AND date = $2`, [emp_id, targetDate]);
    if (dup.rows.length > 0) {
      return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: "Attendance already exists for this employee on this date.", attendance_id: dup.rows[0].attendance_id } });
    }

    const punchTime = punch_in_time || new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
    const { rows } = await pool.query(
      `INSERT INTO attendance (emp_id, date, ward_id, punch_in_time, in_address, latitude_in, longitude_in)
       VALUES ($1, $2::date, $3, $4::time, $5, $6, $7)
       RETURNING attendance_id, emp_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in_time, 'HH24:MI:SS') AS punch_in`,
      [emp_id, targetDate, ward_id, punchTime, address || null, latitude || null, longitude || null]
    );
    res.status(201).json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] markPunchIn error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * POST /api/v1/external/attendance/punch-out
 */
const markPunchOut = async (req, res) => {
  try {
    const { emp_id, date, punch_out_time, latitude, longitude, address } = req.body;
    if (!emp_id) return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "emp_id is required." } });

    const targetDate = date && isIsoDate(date) ? date : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const blocked = await verifyCityOwnership("employee", "emp_id", emp_id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Employee does not belong to your assigned city." } });

    const punchTime = punch_out_time || new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
    const { rows } = await pool.query(
      `UPDATE attendance SET punch_out_time = $1::time, out_address = $2, latitude_out = $3, longitude_out = $4, updated_at = NOW()
       WHERE emp_id = $5 AND date = $6::date AND punch_out_time IS NULL
       RETURNING attendance_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in_time, 'HH24:MI:SS') AS punch_in, TO_CHAR(punch_out_time, 'HH24:MI:SS') AS punch_out`,
      [punchTime, address || null, latitude || null, longitude || null, emp_id, targetDate]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "No open punch-in record found for this employee on this date." } });
    res.json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] markPunchOut error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * PUT /api/v1/external/attendance/:attendanceId
 * Edit an existing attendance record
 */
const editAttendance = async (req, res) => {
  try {
    const { attendanceId } = req.params;
    const { punch_in_time, punch_out_time, leave_type } = req.body;

    const blocked = await verifyCityOwnership("attendance", "attendance_id", attendanceId, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "This record does not belong to your assigned city." } });

    const sets = [];
    const params = [];
    let idx = 0;
    if (punch_in_time !== undefined) { idx++; sets.push(`punch_in_time = $${idx}::time`); params.push(punch_in_time); }
    if (punch_out_time !== undefined) { idx++; sets.push(`punch_out_time = $${idx}::time`); params.push(punch_out_time); }
    if (leave_type !== undefined) { idx++; sets.push(`leave_type = $${idx}`); params.push(leave_type || null); }
    if (sets.length === 0) return res.status(400).json({ success: false, error: { code: "NO_CHANGES", message: "Provide at least one field to update." } });

    idx++; sets.push(`updated_at = NOW()`);
    params.push(attendanceId);

    const { rows } = await pool.query(
      `UPDATE attendance SET ${sets.join(", ")} WHERE attendance_id = $${idx}
       RETURNING attendance_id, emp_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in_time, 'HH24:MI:SS') AS punch_in, TO_CHAR(punch_out_time, 'HH24:MI:SS') AS punch_out, leave_type`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Attendance record not found." } });
    res.json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] editAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * DELETE /api/v1/external/attendance/:attendanceId
 */
const deleteAttendance = async (req, res) => {
  try {
    const { attendanceId } = req.params;
    const blocked = await verifyCityOwnership("attendance", "attendance_id", attendanceId, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "This record does not belong to your assigned city." } });

    const { rowCount } = await pool.query(`DELETE FROM attendance WHERE attendance_id = $1`, [attendanceId]);
    if (rowCount === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Attendance record not found." } });
    res.json({ success: true, message: "Attendance record deleted.", meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] deleteAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * POST /api/v1/external/attendance/mark-leave
 */
const markLeave = async (req, res) => {
  try {
    const { emp_id, ward_id, date, leave_type } = req.body;
    if (!emp_id || !ward_id || !leave_type) return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "emp_id, ward_id, and leave_type are required." } });
    const targetDate = date && isIsoDate(date) ? date : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const blocked = await verifyCityOwnership("employee", "emp_id", emp_id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Employee does not belong to your assigned city." } });
    const wardBlocked = await verifyWardWithinKeyScope(ward_id, req.apiKey);
    if (wardBlocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "ward_id is outside your assigned scope." } });

    const dup = await pool.query(`SELECT attendance_id FROM attendance WHERE emp_id = $1 AND date = $2`, [emp_id, targetDate]);
    if (dup.rows.length > 0) return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: "Record already exists for this date." } });

    const { rows } = await pool.query(
      `INSERT INTO attendance (emp_id, date, ward_id, leave_type) VALUES ($1, $2::date, $3, $4)
       RETURNING attendance_id, emp_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, leave_type`,
      [emp_id, targetDate, ward_id, leave_type]
    );
    res.status(201).json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] markLeave error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

// ═══════════════════════════════════════════════════════════
//  PROFESSIONAL ATTENDANCE — WRITE OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/v1/external/professional/attendance/punch-in
 */
const markProfessionalPunchIn = async (req, res) => {
  try {
    const { professional_id, date, latitude, longitude } = req.body;
    if (!professional_id) return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "professional_id is required." } });
    const targetDate = date && isIsoDate(date) ? date : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    const blocked = await verifyCityOwnership("professional_employees", "id", professional_id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Professional does not belong to your assigned city." } });

    const dup = await pool.query(`SELECT id FROM professional_attendance WHERE professional_id = $1 AND date = $2`, [professional_id, targetDate]);
    if (dup.rows.length > 0) return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: "Already punched in for this date." } });

    // Get employee's ward/zone/city for the record
    const emp = await pool.query(`SELECT ward_id, zone_id, city_id FROM professional_employees WHERE id = $1 AND is_active = true`, [professional_id]);
    if (emp.rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Professional not found or inactive." } });
    const { ward_id, zone_id, city_id } = emp.rows[0];

    const { rows } = await pool.query(
      `INSERT INTO professional_attendance (professional_id, date, punch_in, ward_id, zone_id, city_id, punch_in_latitude, punch_in_longitude)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
       RETURNING id, professional_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in, 'HH24:MI:SS') AS punch_in`,
      [professional_id, targetDate, ward_id, zone_id, city_id, latitude || null, longitude || null]
    );
    res.status(201).json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] markProfessionalPunchIn error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * POST /api/v1/external/professional/attendance/punch-out
 */
const markProfessionalPunchOut = async (req, res) => {
  try {
    const { professional_id, date, latitude, longitude } = req.body;
    if (!professional_id) return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "professional_id is required." } });
    const targetDate = date && isIsoDate(date) ? date : new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    const blocked = await verifyCityOwnership("professional_employees", "id", professional_id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Professional does not belong to your assigned city." } });

    const { rows } = await pool.query(
      `UPDATE professional_attendance SET punch_out = NOW(), punch_out_latitude = $1, punch_out_longitude = $2
       WHERE professional_id = $3 AND date = $4 AND punch_out IS NULL
       RETURNING id, professional_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in, 'HH24:MI:SS') AS punch_in, TO_CHAR(punch_out, 'HH24:MI:SS') AS punch_out,
       ROUND(EXTRACT(EPOCH FROM (punch_out - punch_in)) / 3600, 2) AS hours_worked`,
      [latitude || null, longitude || null, professional_id, targetDate]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "No open punch-in found for this professional on this date." } });
    res.json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] markProfessionalPunchOut error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * PUT /api/v1/external/professional/attendance/:id
 */
const editProfessionalAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { punch_in, punch_out } = req.body;

    const blocked = await verifyCityOwnership("professional_attendance", "id", id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "This record does not belong to your assigned city." } });

    const sets = [];
    const params = [];
    let idx = 0;
    if (punch_in !== undefined) { idx++; sets.push(`punch_in = $${idx}::timestamptz`); params.push(punch_in); }
    if (punch_out !== undefined) { idx++; sets.push(`punch_out = $${idx}::timestamptz`); params.push(punch_out); }
    if (sets.length === 0) return res.status(400).json({ success: false, error: { code: "NO_CHANGES", message: "Provide punch_in or punch_out to update." } });

    idx++; params.push(id);
    const { rows } = await pool.query(
      `UPDATE professional_attendance SET ${sets.join(", ")} WHERE id = $${idx}
       RETURNING id, professional_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in, 'HH24:MI:SS') AS punch_in, TO_CHAR(punch_out, 'HH24:MI:SS') AS punch_out`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Record not found." } });
    res.json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] editProfessionalAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * DELETE /api/v1/external/professional/attendance/:id
 */
const deleteProfessionalAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const blocked = await verifyCityOwnership("professional_attendance", "id", id, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "This record does not belong to your assigned city." } });

    const { rowCount } = await pool.query(`DELETE FROM professional_attendance WHERE id = $1`, [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Record not found." } });
    res.json({ success: true, message: "Professional attendance record deleted.", meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] deleteProfessionalAttendance error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * GET /api/v1/external/employees/:empId
 */
const getEmployeeById = async (req, res) => {
  try {
    const { empId } = req.params;
    const params = [empId];
    let paramCount = 1;
    let cityFilter = "";

    if (req.apiKey.cityId) {
      paramCount++;
      cityFilter += ` AND c.city_id = $${paramCount}`;
      params.push(req.apiKey.cityId);
    }

    if (req.apiKey.zoneId) {
      paramCount++;
      cityFilter += ` AND z.zone_id = $${paramCount}`;
      params.push(req.apiKey.zoneId);
    }

    if (req.apiKey.wardId) {
      paramCount++;
      cityFilter += ` AND w.ward_id = $${paramCount}`;
      params.push(req.apiKey.wardId);
    }

    const result = await pool.query(
      `SELECT e.emp_id, e.name, e.emp_code, e.phone, e.aadhar_no,
              w.ward_id, w.ward_name AS ward, z.zone_name AS zone, c.city_name AS city,
              des.designation_id, des.designation_name AS designation, dept.department_name AS department
       FROM employee e
       JOIN wards w ON e.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       LEFT JOIN designation des ON e.designation_id = des.designation_id
       LEFT JOIN department dept ON des.department_id = dept.department_id
       WHERE e.emp_id = $1 ${cityFilter}`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Employee not found or not in your city." } });
    }

    res.json({ success: true, data: result.rows[0], meta: meta() });
  } catch (error) {
    console.error("[ExternalAPI] getEmployeeById error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * POST /api/v1/external/employees
 * Create a new employee
 */
const createEmployee = async (req, res) => {
  try {
    const { name, emp_code, phone, ward_id, designation_id, aadhar_no } = req.body;

    if (!emp_code || !name || !ward_id) {
      return res.status(400).json({ success: false, error: { code: "MISSING_FIELDS", message: "emp_code, name, and ward_id are required." } });
    }

    const wardBlocked = await verifyWardWithinKeyScope(ward_id, req.apiKey);
    if (wardBlocked) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "The specified ward_id is outside your assigned scope." } });
    }

    const { rows } = await pool.query(
      `INSERT INTO employee (emp_code, name, phone, ward_id, designation_id, aadhar_no)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING emp_id, emp_code, name, phone, ward_id, designation_id, aadhar_no`,
      [emp_code.trim(), name.trim(), phone || null, ward_id, designation_id || null, aadhar_no || null]
    );

    res.status(201).json({ success: true, message: "Employee created successfully.", data: rows[0], meta: meta() });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: `Employee with emp_code '${req.body.emp_code}' already exists.` } });
    }
    console.error("[ExternalAPI] createEmployee error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * PUT /api/v1/external/employees/:empId
 * Update an existing employee
 */
const updateEmployee = async (req, res) => {
  try {
    const { empId } = req.params;
    const { name, emp_code, phone, ward_id, designation_id, aadhar_no } = req.body;

    const blocked = await verifyCityOwnership("employee", "emp_id", empId, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "This employee does not belong to your assigned city." } });
    }

    // If ward_id is changing, verify it remains inside every configured key scope.
    if (ward_id) {
      const wardBlocked = await verifyWardWithinKeyScope(ward_id, req.apiKey);
      if (wardBlocked) {
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "The new ward_id is outside your assigned scope." } });
      }
    }

    const { rows } = await pool.query(
      `UPDATE employee SET
         name = COALESCE($1, name),
         emp_code = COALESCE($2, emp_code),
         phone = COALESCE($3, phone),
         ward_id = COALESCE($4, ward_id),
         designation_id = COALESCE($5, designation_id),
         aadhar_no = COALESCE($6, aadhar_no)
       WHERE emp_id = $7
       RETURNING emp_id, emp_code, name, phone, ward_id, designation_id, aadhar_no`,
      [
        name ? name.trim() : null,
        emp_code ? emp_code.trim() : null,
        phone !== undefined ? phone : null,
        ward_id || null,
        designation_id || null,
        aadhar_no !== undefined ? aadhar_no : null,
        empId,
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Employee not found." } });
    }

    res.json({ success: true, message: "Employee updated successfully.", data: rows[0], meta: meta() });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, error: { code: "DUPLICATE", message: "emp_code already in use." } });
    }
    console.error("[ExternalAPI] updateEmployee error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

/**
 * DELETE /api/v1/external/employees/:empId
 * Delete an employee (only if in caller's city)
 */
const deleteEmployee = async (req, res) => {
  try {
    const { empId } = req.params;

    const blocked = await verifyCityOwnership("employee", "emp_id", empId, req.apiKey.cityId, req.apiKey.zoneId, req.apiKey.wardId);
    if (blocked) {
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "This employee does not belong to your assigned city." } });
    }

    const { rowCount } = await pool.query(`DELETE FROM employee WHERE emp_id = $1`, [empId]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Employee not found." } });
    }

    res.json({ success: true, message: "Employee deleted successfully.", meta: meta() });
  } catch (error) {
    if (error.code === "23503") {
      return res.status(409).json({ success: false, error: { code: "HAS_DEPENDENCIES", message: "Cannot delete employee because attendance records or other logs exist for them." } });
    }
    console.error("[ExternalAPI] deleteEmployee error:", error.message);
    res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Internal server error." } });
  }
};

module.exports = {
  getDailyAttendance,
  getAttendanceRange,
  getAttendanceSummary,
  getEmployeeAttendance,
  getEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  getProfessionalDailyAttendance,
  // Write — Supervisor/Regular
  markPunchIn,
  markPunchOut,
  editAttendance,
  deleteAttendance,
  markLeave,
  // Write — Professional
  markProfessionalPunchIn,
  markProfessionalPunchOut,
  editProfessionalAttendance,
  deleteProfessionalAttendance,
};
