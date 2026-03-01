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

// Short Attendance summarized report - supports optional wardId (sector) filter
router.get("/short-report", async (req, res) => {
  const { cityName, zoneName, wardId, date } = req.query;
  if (!cityName || !zoneName) {
    return res
      .status(400)
      .json({ error: "cityName and zoneName query params are required." });
  }

  const targetDate = date || formatDateIST();
  const scope = req.cityScope || { all: false, ids: [] };
  if (!scope.all && (!scope.ids || scope.ids.length === 0)) {
    return res
      .status(403)
      .json({ error: "No city access assigned. Please contact admin." });
  }

  try {
    const cityLookup = await pool.query(
      `SELECT city_id FROM public.cities WHERE city_name = $1 LIMIT 1`,
      [cityName]
    );

    if (cityLookup.rows.length === 0) {
      return res.status(404).json({ error: "City not found." });
    }

    const requestedCityId = Number(cityLookup.rows[0].city_id);
    if (
      !scope.all &&
      (!scope.ids || !scope.ids.map(Number).includes(requestedCityId))
    ) {
      return res
        .status(403)
        .json({ error: "Forbidden: city not assigned to this user." });
    }

    // Build dynamic WHERE clauses for optional wardId (sector) filter
    const params = [cityName, zoneName, targetDate];
    let extraClause = "";
    if (wardId && wardId !== "all") {
      params.push(Number(wardId));
      extraClause += ` AND w.sector_id = $${params.length}`;
    }
    if (!scope.all) {
      params.push(scope.ids);
      extraClause += ` AND c.city_id = ANY($${params.length})`;
    }

    const { rows } = await pool.query(
      `SELECT 
        c.city_name,
        z.zone_name,
        s.sector_name AS ward_name,
        w.ward_name AS kothi_name,
        COALESCE(STRING_AGG(DISTINCT u.name, ', ' ORDER BY u.name), '') AS supervisor_names,
        COALESCE(STRING_AGG(DISTINCT dept.department_name, ', ' ORDER BY dept.department_name), '') AS departments,
        COALESCE(
          JSON_AGG(
            JSONB_BUILD_OBJECT(
              'department', dept_stats.department_name,
              'total_registered', dept_stats.total_registered,
              'total_present', dept_stats.total_present
            )
          ) FILTER (WHERE dept_stats.department_name IS NOT NULL),
          '[]'
        ) AS department_stats,
        COUNT(DISTINCT e.emp_id) AS total_registered_employees,
        COUNT(
          DISTINCT CASE 
            WHEN a.date::date = $3 THEN a.attendance_id 
          END
        ) AS total_present_employees
      FROM public.wards w
      JOIN public.zones z ON w.zone_id = z.zone_id
      JOIN public.cities c ON z.city_id = c.city_id
      LEFT JOIN public.sectors s ON w.sector_id = s.sector_id
      LEFT JOIN public.employee e ON w.ward_id = e.ward_id
      LEFT JOIN public.designation ds ON e.designation_id = ds.designation_id
      LEFT JOIN public.department dept ON ds.department_id = dept.department_id
      LEFT JOIN public.supervisor_ward sw ON w.ward_id = sw.ward_id
      LEFT JOIN public.users u ON sw.supervisor_id = u.user_id
      LEFT JOIN public.attendance a ON e.emp_id = a.emp_id
      LEFT JOIN LATERAL (
        SELECT 
          d.department_name,
          COUNT(DISTINCT e2.emp_id) AS total_registered,
          COUNT(
            DISTINCT CASE 
              WHEN a2.date::date = $3 THEN a2.attendance_id 
            END
          ) AS total_present
        FROM public.employee e2
        JOIN public.designation ds2 ON e2.designation_id = ds2.designation_id
        JOIN public.department d ON ds2.department_id = d.department_id
        LEFT JOIN public.attendance a2 ON e2.emp_id = a2.emp_id
        WHERE e2.ward_id = w.ward_id
        GROUP BY d.department_name
      ) AS dept_stats ON true
      WHERE c.city_name = $1
        AND z.zone_name = $2
        ${extraClause}
      GROUP BY c.city_name, z.zone_name, s.sector_name, w.ward_name
      ORDER BY s.sector_name ASC NULLS LAST, w.ward_name ASC`,
      params
    );

    res.json(rows);
  } catch (error) {
    console.error("Error fetching short attendance report:", error);
    res
      .status(500)
      .json({ error: "Unable to fetch short attendance report." });
  }
});

module.exports = router;
