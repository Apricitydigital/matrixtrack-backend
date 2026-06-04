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

const readParam = (req, keys = []) => {
  for (const key of keys) {
    const value = req?.query?.[key] ?? req?.body?.[key];
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== "" &&
      String(value).toLowerCase() !== "undefined" &&
      String(value).toLowerCase() !== "null"
    ) {
      return String(value).trim();
    }
  }
  return null;
};

const normalizeDateInput = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};

router.use(authenticate, attachKothiScope, attachCityScope, requireCityScope());

// 🟢 Fetch attendance report for a specific date or date range
const handleAttendanceReport = async (req, res) => {
  const startDateRaw = readParam(req, ["startDate", "start_date", "fromDate", "from_date", "from"]);
  const endDateRaw = readParam(req, ["endDate", "end_date", "toDate", "to_date", "to"]);
  const singleDateRaw = readParam(req, ["date", "singleDate", "single_date"]);

  const scope = req.cityScope || { all: false, ids: [] };
  const kothiScope = req.kothiScope || { all: true, ids: [] };

  if (!scope.all && (!scope.ids || scope.ids.length === 0)) {
    return res
      .status(403)
      .json({ error: "No city access assigned. Please contact admin." });
  }

  try {
    const startDate = normalizeDateInput(startDateRaw);
    const endDate = normalizeDateInput(endDateRaw);
    const singleDate = normalizeDateInput(singleDateRaw);

    if (
      (startDateRaw && !startDate) ||
      (endDateRaw && !endDate) ||
      (singleDateRaw && !singleDate)
    ) {
      return res
        .status(400)
        .json({ error: "Invalid date format. Use YYYY-MM-DD or ISO date." });
    }

    let dateFilter;
    let params;

    if (startDate || endDate) {
      const start = startDate || endDate;
      const end = endDate || startDate;
      const rangeStart = start <= end ? start : end;
      const rangeEnd = start <= end ? end : start;
      dateFilter = "a.date::date BETWEEN $1 AND $2";
      params = [rangeStart, rangeEnd];
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
        TO_CHAR((a.mid_shift_punch_in_time AT TIME ZONE 'Asia/Kolkata'), 'HH24:MI:SS') AS mid_shift_punch_in,
        a.in_address,
        a.latitude_in,
        a.longitude_in,
        a.punch_in_image, 
        a.mid_in_address,
        a.latitude_mid_in,
        a.longitude_mid_in,
        a.mid_shift_punch_in_image,
        TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out, 
        a.out_address,
        a.latitude_out,
        a.longitude_out,
        a.punch_out_image, 
        COALESCE(a.auto_punched_out, false) AS is_auto_punch_out,
        a.duration,
        a.leave_type,
        u.name AS punched_in_by,
        u2.name AS mid_shift_punched_in_by,
        u1.name AS punched_out_by
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON a.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN designation des ON e.designation_id = des.designation_id
      LEFT JOIN department dept ON des.department_id = dept.department_id
      LEFT JOIN users u ON a.punched_in_by = u.user_id
      LEFT JOIN users u2 ON a.mid_shift_punched_in_by = u2.user_id
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
};

router.get("/", handleAttendanceReport);
router.post("/", handleAttendanceReport);

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
  if (!cityName) {
    return res
      .status(400)
      .json({ error: "cityName query param is required." });
  }

  const targetDate = date || formatDateIST();
  const scope = req.cityScope || { all: false, ids: [] };

  try {
    const cityCheck = await pool.query(
      "SELECT city_id FROM cities WHERE city_name = $1",
      [cityName]
    );
    if (cityCheck.rows.length === 0) {
      return res.status(404).json({ error: "City not found" });
    }
    const reqCityId = cityCheck.rows[0].city_id;

    if (!scope.all && !scope.ids.map(String).includes(String(reqCityId))) {
      return res
        .status(403)
        .json({ error: "Forbidden: city not assigned to this user." });
    }

    const params = [cityName, targetDate];
    let extraClause = "";

    if (zoneName && zoneName !== "all" && zoneName !== "undefined" && zoneName !== "") {
      params.push(zoneName);
      extraClause += ` AND z.zone_name = $${params.length}`;
    }

    if (wardId && wardId !== "all" && wardId !== "undefined" && wardId !== "") {
      params.push(Number(wardId));
      extraClause += ` AND w.sector_id = $${params.length}`;
    }

    if (kothiId && kothiId !== "all" && kothiId !== "undefined" && kothiId !== "") {
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
    s.sector_name AS ward_name,
    w.ward_name AS kothi_name,

    COALESCE(sup.supervisor_names, '') AS supervisor_names,

    COALESCE(
      STRING_AGG(DISTINCT dept.department_name, ', ' ORDER BY dept.department_name),
      ''
    ) AS departments,

    COUNT(DISTINCT e.emp_id) AS total_registered_employees,

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

    COUNT(
      DISTINCT CASE
        WHEN a.mid_shift_punch_in_time IS NOT NULL
        THEN e.emp_id
      END
    ) AS total_mid_shift_punch_in,

    COUNT(
      DISTINCT CASE
        WHEN a.punch_out_time IS NOT NULL
          AND (a.auto_punched_out IS FALSE OR a.auto_punched_out IS NULL)
        THEN e.emp_id
      END
    ) AS manual_punch_out_count,

    COUNT(
      DISTINCT CASE
        WHEN a.punch_out_time IS NOT NULL
          AND a.auto_punched_out IS TRUE
        THEN e.emp_id
      END
    ) AS auto_punch_out_count,

    COUNT(
      DISTINCT CASE
        WHEN a.punch_out_time IS NOT NULL
        THEN e.emp_id
      END
    ) AS total_completed_punch_out,

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

  LEFT JOIN (
    SELECT sw.ward_id, STRING_AGG(u.name, ', ' ORDER BY u.name) AS supervisor_names
    FROM public.supervisor_ward sw
    JOIN public.users u ON u.user_id = sw.supervisor_id
    GROUP BY sw.ward_id
  ) sup ON sup.ward_id = w.ward_id

  LEFT JOIN (
    SELECT DISTINCT ON (emp_id)
      emp_id,
      date,
      punch_in_time,
      punch_out_time,
      mid_shift_punch_in_time,
      auto_punched_out,
      leave_type
    FROM public.attendance
    WHERE date = $2::date
    ORDER BY emp_id, attendance_id DESC
  ) a
    ON a.emp_id = e.emp_id

  WHERE c.city_name = $1
    ${extraClause}

  GROUP BY
    c.city_name,
    z.zone_name,
    s.sector_name,
    w.ward_id,
    w.ward_name,
    sup.supervisor_names

  ORDER BY
    s.sector_name ASC NULLS LAST,
    w.ward_name ASC`,
      params
    );

    res.json(rows);
  } catch (error) {
    console.error("Error fetching short attendance report:", error.message, error.stack);
    res.status(500).json({ error: "Unable to fetch short attendance report." });
  }
});

module.exports = router;
