const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const {
  createAttendanceDownloadHandler,
} = require("../utils/attendanceReportDownload");
const authenticate = require("../middleware/authMiddleware");
const { attachCityScope, requireCityScope, buildCityFilterClause } = require("../middleware/cityScope");
const { attachKothiScope, buildKothiFilterClause } = require("../middleware/kothiScope");

// 🛠 IST Date Formatter
const formatDateIST = (date = new Date()) => {
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
};

router.use(authenticate, attachKothiScope, attachCityScope, requireCityScope());

// 🟢 Fetch attendance report for a specific date or date range
router.post("/", async (req, res) => {
  // Exhaustive check for all possible date param names from query or body
  const startDate = req.query.startDate || req.body.startDate || req.query.start_date || req.body.start_date;
  const endDate = req.query.endDate || req.body.endDate || req.query.end_date || req.body.end_date;
  const singleDate = req.query.date || req.body.date || req.query.singleDate || req.body.singleDate;

  const scope = req.cityScope || { all: false, ids: [] };
  const kothiScope = req.kothiScope || { all: true, ids: [] };

  if (!scope.all && (!scope.ids || scope.ids.length === 0)) {
    return res
      .status(403)
      .json({ error: "No city access assigned. Please contact admin." });
  }

  try {
    let dateFilter;
    let params;

    if (startDate && endDate && startDate !== "undefined" && endDate !== "undefined") {
      dateFilter = "a.date::date BETWEEN $1 AND $2";
      params = [startDate, endDate];
    } else {
      dateFilter = "a.date::date = $1";
      params = [singleDate || formatDateIST()];
    }

    const cityFilter = buildCityFilterClause(scope, "c", params);
    const kothiFilter = buildKothiFilterClause(kothiScope, "w", cityFilter.params);

    const result = await pool.query(
      `SELECT 
        ROW_NUMBER() OVER (ORDER BY a.date ASC, a.attendance_id ASC) AS sr_no,
        e.emp_id,
        attendance_id,
        e.name, 
        e.emp_code, 
        TO_CHAR(a.date, 'DD-MM-YYYY') AS date,
        w.ward_name AS ward, 
        z.zone_name AS zone, 
        c.city_name AS city, 
        dept.department_name AS department,
        des.designation_name AS designation,
        e.phone AS contact_no, 
        TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in, 
        a.in_address,
        a.latitude_in,
        a.longitude_in,
        a.punch_in_image, 
        TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out, 
        a.out_address,
        a.latitude_out,
        a.longitude_out,
        a.punch_out_image, 
        COALESCE(a.auto_punched_out, false) AS is_auto_punch_out,
        a.duration,
        a.leave_type,
        u.name AS punched_in_by,
        u1.name AS punched_out_by
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON a.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN designation des ON e.designation_id = des.designation_id
      LEFT JOIN department dept ON des.department_id = dept.department_id
      LEFT JOIN users u ON a.punched_in_by = u.user_id
      LEFT JOIN users u1 ON a.punched_out_by = u1.user_id
      WHERE ${dateFilter}
        ${cityFilter.clause} ${kothiFilter.clause}
      ORDER BY a.date ASC, a.attendance_id ASC;`,
      kothiFilter.params
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching attendance report:", error);
    res.status(500).json({ error: "Database error", details: error.message });
  }
});

const handleAttendanceDownload = createAttendanceDownloadHandler({
  pool,
  resolveCityScope: (req) => req.cityScope,
  resolveKothiScope: (req) => req.kothiScope,
});

// Download attendance reports with flexible grouping & filters
router.get("/download", handleAttendanceDownload);
router.post("/download", handleAttendanceDownload);

// Short Attendance summarized report - supports optional wardId (sector) and kothiId filters
router.get("/short-report", async (req, res) => {
  const { cityName, zoneName, wardId, kothiId, date } = req.query;

  if (!cityName || !zoneName) {
    return res.status(400).json({
      error: "cityName and zoneName query params are required.",
    });
  }

  const targetDate = date || formatDateIST();
  const scope = req.cityScope || { all: false, ids: [] };

  try {
    // Verify city exists
    const cityCheck = await pool.query(
      `SELECT city_id
       FROM cities
       WHERE city_name = $1`,
      [cityName]
    );

    if (cityCheck.rows.length === 0) {
      return res.status(404).json({
        error: "City not found",
      });
    }

    const reqCityId = cityCheck.rows[0].city_id;

    // Scope validation
    if (
      !scope.all &&
      !scope.ids.map(String).includes(String(reqCityId))
    ) {
      return res.status(403).json({
        error: "Forbidden: city not assigned to this user.",
      });
    }

    // Dynamic filters
    const params = [cityName, zoneName, targetDate];
    let extraClause = "";

    // Ward/Sector filter
    if (wardId && wardId !== "all") {
      params.push(Number(wardId));
      extraClause += ` AND w.sector_id = $${params.length}`;
    }

    // Kothi filter
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

    // City scope filter
    if (!scope.all) {
      params.push(
        scope.ids
          .map(Number)
          .filter((id) => !isNaN(id))
      );

      extraClause += ` AND c.city_id = ANY($${params.length})`;
    }

    const query = `
      WITH attendance_today AS (
        SELECT
          emp_id,
          punch_in_time,
          leave_type
        FROM public.attendance
        WHERE date >= $3::date
          AND date < ($3::date + INTERVAL '1 day')
      )

      SELECT
          c.city_name,

          z.zone_name,

          s.sector_name AS ward_name,

          w.ward_name AS kothi_name,

          COALESCE(
              STRING_AGG(
                  DISTINCT u.name,
                  ', ' ORDER BY u.name
              ),
              ''
          ) AS supervisor_names,

          COALESCE(
              STRING_AGG(
                  DISTINCT dept.department_name,
                  ', ' ORDER BY dept.department_name
              ),
              ''
          ) AS departments,

          COUNT(DISTINCT e.emp_id)
              AS total_registered_employees,

          COUNT(
              DISTINCT CASE
                  WHEN a.punch_in_time IS NOT NULL
                  THEN e.emp_id
              END
          ) AS total_present_employees,

          COUNT(
              DISTINCT CASE
                  WHEN a.leave_type IS NOT NULL
                  THEN e.emp_id
              END
          ) AS total_leave_employees,

          ARRAY_REMOVE(
              ARRAY_AGG(DISTINCT e.emp_id),
              NULL
          ) AS registered_emp_ids,

          ARRAY_REMOVE(
              ARRAY_AGG(
                  DISTINCT CASE
                      WHEN a.punch_in_time IS NOT NULL
                      THEN e.emp_id
                  END
              ),
              NULL
          ) AS present_emp_ids,

          ARRAY_REMOVE(
              ARRAY_AGG(
                  DISTINCT CASE
                      WHEN a.leave_type IS NOT NULL
                      THEN e.emp_id
                  END
              ),
              NULL
          ) AS leave_emp_ids

      FROM public.wards w

      JOIN public.zones z
          ON w.zone_id = z.zone_id

      JOIN public.cities c
          ON z.city_id = c.city_id

      LEFT JOIN public.sectors s
          ON w.sector_id = s.sector_id

      LEFT JOIN public.employee e
          ON e.ward_id = w.ward_id

      LEFT JOIN public.designation des
          ON e.designation_id = des.designation_id

      LEFT JOIN public.department dept
          ON des.department_id = dept.department_id

      LEFT JOIN public.supervisor_ward sw
          ON sw.ward_id = w.ward_id

      LEFT JOIN public.users u
          ON u.user_id = sw.supervisor_id

      LEFT JOIN attendance_today a
          ON a.emp_id = e.emp_id

      WHERE c.city_name = $1
        AND z.zone_name = $2
        ${extraClause}

      GROUP BY
          c.city_name,
          z.zone_name,
          s.sector_name,
          w.ward_id,
          w.ward_name

      ORDER BY
          s.sector_name ASC NULLS LAST,
          w.ward_name ASC
    `;

    const { rows } = await pool.query(query, params);

    return res.json(rows);

  } catch (error) {
    console.error(
      "Error fetching short attendance report:",
      error.message,
      error.stack
    );

    return res.status(500).json({
      error: "Unable to fetch short attendance report.",
    });
  }
});

module.exports = router;
