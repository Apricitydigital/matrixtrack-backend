/**
 * External API Controller
 * External employee and attendance API with API-key scope enforcement.
 */

const pool = require("../config/db");
const { withUnblockedAttendance } = require('../utils/professionalAttendanceBlock');

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

const meta = () => ({
  api_version: "v1",
  timestamp: new Date().toISOString(),
});

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

    // Get employee's ward/zone/city for the record
    const emp = await pool.query(`SELECT ward_id, zone_id, city_id FROM professional_employees WHERE id = $1 AND is_active = true`, [professional_id]);
    if (emp.rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Professional not found or inactive." } });
    const { ward_id, zone_id, city_id } = emp.rows[0];

    const { rows } = await withUnblockedAttendance(professional_id, async client => {
      const dup = await client.query('SELECT id FROM professional_attendance WHERE professional_id=$1 AND date=$2', [professional_id, targetDate]);
      if (dup.rows.length) throw Object.assign(new Error('Already punched in for this date.'), { status: 409, code: 'DUPLICATE' });
      return client.query(`INSERT INTO professional_attendance (professional_id, date, punch_in, ward_id, zone_id, city_id, punch_in_latitude, punch_in_longitude)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)
       RETURNING id, professional_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in, 'HH24:MI:SS') AS punch_in`,
      [professional_id, targetDate, ward_id, zone_id, city_id, latitude || null, longitude || null]
      );
    });
    res.status(201).json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
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

    const { rows } = await withUnblockedAttendance(professional_id, client => client.query(
      `UPDATE professional_attendance SET punch_out = NOW(), punch_out_latitude = $1, punch_out_longitude = $2
       WHERE professional_id = $3 AND date = $4 AND punch_out IS NULL
       RETURNING id, professional_id, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(punch_in, 'HH24:MI:SS') AS punch_in, TO_CHAR(punch_out, 'HH24:MI:SS') AS punch_out,
       ROUND(EXTRACT(EPOCH FROM (punch_out - punch_in)) / 3600, 2) AS hours_worked`,
      [latitude || null, longitude || null, professional_id, targetDate]
    ));
    if (rows.length === 0) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "No open punch-in found for this professional on this date." } });
    res.json({ success: true, data: rows[0], meta: meta() });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
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
  ...require('./externalAttendanceReadController'),
  createEmployee,
  updateEmployee,
  deleteEmployee,
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
