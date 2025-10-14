const express = require("express");
const router = express.Router();
const pool = require("../../config/db");

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 120;

const normalizeDateInput = (value, fallbackIso) => {
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

const resolveDateRange = (startRaw, endRaw) => {
  const todayIso = new Date().toISOString().split("T")[0];
  const startIso = normalizeDateInput(startRaw, todayIso);
  const endIso = normalizeDateInput(endRaw, startIso);

  if (startIso <= endIso) {
    return { startDate: startIso, endDate: endIso };
  }

  return { startDate: endIso, endDate: startIso };
};

const formatDuration = (minutes) => {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }

  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;

  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${mins}m`;
};

const formatDisplayTime = (value) => {
  if (!value) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    }).format(value);
  } catch (_error) {
    return value.toISOString();
  }
};

router.get("/daily", async (req, res) => {
  try {
    const empIdRaw = req.query.empId ?? req.query.emp_id ?? req.query.id;
    const startRaw = req.query.startDate ?? req.query.start ?? req.query.from;
    const endRaw = req.query.endDate ?? req.query.end ?? req.query.to;

    const empId = Number(empIdRaw);
    if (!Number.isFinite(empId) || empId <= 0) {
      return res
        .status(400)
        .json({ success: false, error: "Valid employee ID is required." });
    }

    const { startDate, endDate } = resolveDateRange(startRaw, endRaw);
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = end.getTime() - start.getTime();
    const rangeDays = Math.max(
      1,
      Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1
    );

    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({
        success: false,
        error: `Date range is too large. Limit queries to ${MAX_RANGE_DAYS} days or fewer.`,
      });
    }

    const employeeInfoQuery = `
      SELECT
        e.emp_id AS id,
        e.emp_code AS emp_code,
        e.name AS name,
        e.phone AS phone,
        d.designation_name AS designation,
        dept.department_name AS department,
        w.ward_name AS ward,
        z.zone_name AS zone,
        c.city_name AS city,
        c.state AS state
      FROM employee e
      LEFT JOIN designation d ON e.designation_id = d.designation_id
      LEFT JOIN department dept ON d.department_id = dept.department_id
      LEFT JOIN wards w ON e.ward_id = w.ward_id
      LEFT JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN cities c ON z.city_id = c.city_id
      WHERE e.emp_id = $1
      LIMIT 1;
    `;

    const employeeInfoResult = await pool.query(employeeInfoQuery, [empId]);

    if (!employeeInfoResult.rows.length) {
      return res
        .status(404)
        .json({ success: false, error: "Employee not found." });
    }

    const recordsQuery = `
      WITH date_series AS (
        SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day
      )
      SELECT
        ds.day AS attendance_date,
        TO_CHAR(ds.day, 'YYYY-MM-DD') AS attendance_date_iso,
        TO_CHAR(ds.day, 'Dy, DD Mon YYYY') AS attendance_date_label,
        a.attendance_id,
        a.punch_in_time,
        a.punch_out_time,
        a.in_address,
        a.out_address,
        TO_CHAR((a.punch_in_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS punch_in_display,
        TO_CHAR((a.punch_out_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS punch_out_display,
        CASE
          WHEN a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL THEN 'Marked'
          WHEN a.punch_in_time IS NOT NULL THEN 'In Progress'
          ELSE 'Not Marked'
        END AS attendance_status
      FROM date_series ds
      LEFT JOIN attendance a
        ON a.emp_id = $1
       AND a.date::date = ds.day
      ORDER BY ds.day ASC;
    `;

    const recordsResult = await pool.query(recordsQuery, [
      empId,
      startDate,
      endDate,
    ]);

    const records = recordsResult.rows.map((row) => {
      const punchInRaw = row.punch_in_time ? new Date(row.punch_in_time) : null;
      const punchOutRaw = row.punch_out_time
        ? new Date(row.punch_out_time)
        : null;

      const hasPunchIn = Boolean(punchInRaw);
      const hasPunchOut = Boolean(punchOutRaw);

      let durationMinutes = null;
      if (hasPunchIn && hasPunchOut) {
        const diff =
          (punchOutRaw.getTime() - punchInRaw.getTime()) / (1000 * 60);
        if (Number.isFinite(diff) && diff > 0) {
          durationMinutes = Math.round(diff);
        }
      }

      const status = row.attendance_status || "Not Marked";
      const isoDate = row.attendance_date_iso;

      return {
        date: isoDate,
        dateLabel: row.attendance_date_label ?? isoDate,
        attendanceId: row.attendance_id ?? null,
        punchInIso: punchInRaw ? punchInRaw.toISOString() : null,
        punchOutIso: punchOutRaw ? punchOutRaw.toISOString() : null,
        punchInDisplay: row.punch_in_display || formatDisplayTime(punchInRaw),
        punchOutDisplay:
          row.punch_out_display || formatDisplayTime(punchOutRaw),
        hasPunchIn,
        hasPunchOut,
        status,
        inAddress: row.in_address || null,
        outAddress: row.out_address || null,
        durationMinutes,
        durationDisplay: formatDuration(durationMinutes),
      };
    });

    const stats = records.reduce(
      (acc, record) => {
        acc.totalDays += 1;
        if (record.hasPunchIn) {
          acc.punchInCount += 1;
        }
        if (record.hasPunchOut) {
          acc.punchOutCount += 1;
        }
        if (record.status === "Marked") {
          acc.markedDays += 1;
        } else if (record.status === "In Progress") {
          acc.inProgressDays += 1;
        } else {
          acc.notMarkedDays += 1;
        }

        if (Number.isFinite(record.durationMinutes)) {
          acc.totalDurationMinutes += record.durationMinutes;
        }

        return acc;
      },
      {
        totalDays: 0,
        punchInCount: 0,
        punchOutCount: 0,
        markedDays: 0,
        inProgressDays: 0,
        notMarkedDays: 0,
        totalDurationMinutes: 0,
      }
    );

    const totalDurationDisplay = formatDuration(stats.totalDurationMinutes);

    res.json({
      success: true,
      data: {
        employee: employeeInfoResult.rows[0],
        range: {
          startDate,
          endDate,
          totalDays: stats.totalDays,
        },
        stats: {
          ...stats,
          totalDurationDisplay: totalDurationDisplay ?? "0m",
        },
        records,
      },
    });
  } catch (error) {
    console.error("Employee daily attendance error:", error);
    res.status(500).json({
      success: false,
      error: "Unable to fetch employee attendance details.",
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const { empId, month } = req.query;

    if (!month) {
      return res.status(400).json({ error: "Month and year are required." });
    }

    const query = `
            SELECT e.emp_id AS "empId",
       e.emp_code as "empCode", 
       e.name AS "name", 
       e.phone AS "phone", 
       w.ward_name AS "ward", 
       z.zone_name AS "zone", 
       c.city_name AS "city", 
       c.state AS "state", 
	     e.face_id as "faceId",
       COUNT(CASE WHEN a.punch_in_time IS NOT NULL THEN a.attendance_id END) AS "totalAttendance"
FROM employee e
JOIN wards w ON e.ward_id = w.ward_id
JOIN zones z ON w.zone_id = z.zone_id
JOIN cities c ON z.city_id = c.city_id
LEFT JOIN attendance a ON e.emp_id = a.emp_id 
    AND TO_CHAR(a.date, 'yyyy-MM') = $1
WHERE e.emp_id = $2
GROUP BY e.emp_id, w.ward_name, z.zone_name, c.city_name, c.state;
        `;

    const { rows } = await pool.query(query, [month, empId]);

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Employee not found or no attendance records." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
