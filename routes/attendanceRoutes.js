const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const {
  createAttendanceDownloadHandler,
} = require("../utils/attendanceReportDownload");
const authenticate = require("../middleware/authMiddleware");
const { attachCityScope, requireCityScope } = require("../middleware/cityScope");

// 🛠 IST Date Formatter
const formatDateIST = (date = new Date()) => {
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
};

router.use(authenticate, attachCityScope, requireCityScope());

// 🟢 Fetch attendance report for a specific date (current date or selected date)
router.post("/", async (req, res) => {
  // Get the date from query parameters, if available; otherwise, default to IST date
  const date = req.query.date || formatDateIST(); // IST Date in YYYY-MM-DD format
  const scope = req.cityScope || { all: false, ids: [] };
  if (!scope.all && (!scope.ids || scope.ids.length === 0)) {
    return res
      .status(403)
      .json({ error: "No city access assigned. Please contact admin." });
  }

  try {
    const params = [date];
    let cityClause = "";
    if (!scope.all) {
      params.push(scope.ids);
      cityClause = `AND c.city_id = ANY($${params.length})`;
    }

    const result = await pool.query(
      `SELECT 
        ROW_NUMBER() OVER (ORDER BY a.date DESC, a.attendance_id) AS sr_no,
        e.emp_id,
        attendance_id,
        e.name, 
        e.emp_code, 
        TO_CHAR(a.date, 'DD-MM-YYYY') AS date,
        w.ward_name AS ward, 
        z.zone_name AS zone, 
        c.city_name AS city, 
        e.phone AS contact_no, 
        TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in, 
        a.in_address, 
        a.punch_in_image, 
        TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out, 
        a.out_address, 
        a.punch_out_image, 
        a.duration,
        u.name AS punched_in_by,
        u1.name AS punched_out_by
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON a.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN users u ON a.punched_in_by = u.user_id
      LEFT JOIN users u1 ON a.punched_out_by = u1.user_id
      WHERE a.date = $1
        ${cityClause}
      ORDER BY a.date DESC, a.attendance_id;`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching attendance report:", error);
    res.status(500).json({ error: "Database error" });
  }
});

const handleAttendanceDownload = createAttendanceDownloadHandler({
  pool,
  resolveCityScope: (req) => req.cityScope,
});

// Download attendance reports with flexible grouping & filters
router.get("/download", handleAttendanceDownload);

// Short Attendance summarized report - supports optional wardId (sector) and kothiId filters
router.get("/short-report", async (req, res) => {
  const { cityName, zoneName, wardId, kothiId, date } = req.query;
  if (!cityName || !zoneName) {
    return res
      .status(400)
      .json({ error: "cityName and zoneName query params are required." });
  }

  const targetDate = date || formatDateIST();
  const scope = req.cityScope || { all: false, ids: [] };

  try {
    // Verify city exists
    const cityCheck = await pool.query(
      "SELECT city_id FROM cities WHERE city_name = $1",
      [cityName]
    );
    if (cityCheck.rows.length === 0) {
      return res.status(404).json({ error: "City not found" });
    }
    const reqCityId = cityCheck.rows[0].city_id;

    // Scope check — compare as strings to avoid int/string mismatch
    if (!scope.all && !scope.ids.map(String).includes(String(reqCityId))) {
      return res
        .status(403)
        .json({ error: "Forbidden: city not assigned to this user." });
    }

    // Build dynamic WHERE clauses
    const params = [cityName, zoneName, targetDate];
    let extraClause = "";

    if (wardId && wardId !== "all") {
      params.push(Number(wardId));
      extraClause += ` AND w.sector_id = $${params.length}`;
    }

    if (kothiId && kothiId !== "all") {
      const kothiIds = String(kothiId)
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => !isNaN(id) && id > 0);
      if (kothiIds.length > 0) {
        params.push(kothiIds);
        extraClause += ` AND w.ward_id = ANY($${params.length})`;
      }
    }

    if (!scope.all) {
      params.push(scope.ids.map(Number).filter((id) => !isNaN(id)));
      extraClause += ` AND c.city_id = ANY($${params.length})`;
    }

    const { rows } = await pool.query(
      `SELECT
        c.city_name,
        z.zone_name,
        s.sector_name                                    AS ward_name,
        w.ward_name                                      AS kothi_name,
        COALESCE(
          STRING_AGG(DISTINCT u.name, ', ' ORDER BY u.name), ''
        )                                                AS supervisor_names,
        COUNT(DISTINCT e.emp_id)                         AS total_registered_employees,
        COUNT(
          DISTINCT CASE
            WHEN a.date::date = $3::date THEN a.attendance_id
          END
        )                                                AS total_present_employees
      FROM public.wards w
      JOIN public.zones    z  ON w.zone_id   = z.zone_id
      JOIN public.cities   c  ON z.city_id   = c.city_id
      LEFT JOIN public.sectors s  ON w.sector_id  = s.sector_id
      LEFT JOIN public.employee e  ON e.ward_id    = w.ward_id
      LEFT JOIN public.supervisor_ward sw ON sw.ward_id = w.ward_id
      LEFT JOIN public.users       u  ON u.user_id   = sw.supervisor_id
      LEFT JOIN public.attendance  a  ON a.emp_id    = e.emp_id
      WHERE c.city_name = $1
        AND z.zone_name = $2
        ${extraClause}
      GROUP BY c.city_name, z.zone_name, s.sector_name, w.ward_id, w.ward_name
      ORDER BY s.sector_name ASC NULLS LAST, w.ward_name ASC`,
      params
    );

    res.json(rows);
  } catch (error) {
    console.error("Error fetching short attendance report:", error.message, error.stack);
    res.status(500).json({ error: "Unable to fetch short attendance report." });
  }
});

module.exports = router;
