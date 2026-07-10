const pool = require("../config/db");

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const startDate = today;
  const endDate = today;

  console.log("Measuring optimized query...");
  console.time("OptimizedQuery");

  try {
    const query = `
      WITH scoped_employees AS (
        SELECT DISTINCT
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
          e.self_attendance_enabled
        FROM employee e
        JOIN wards w ON e.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
        LEFT JOIN designation d ON e.designation_id = d.designation_id
        LEFT JOIN department dept ON d.department_id = dept.department_id
      ),
      attendance_summary AS (
        SELECT
          a.emp_id,
          MAX(CASE WHEN (a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL) THEN 1 ELSE 0 END) AS has_punch_in,
          MAX(CASE WHEN a.mid_shift_punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_mid_shift_punch_in,
          MAX(CASE WHEN (a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL) THEN 1 ELSE 0 END) AS has_punch_start,
          MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
          MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out,
          STRING_AGG(DISTINCT a.leave_type, ', ') AS leave_type,
          COUNT(DISTINCT a.date::date) FILTER (WHERE (a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL)) AS days_present,
          COUNT(DISTINCT a.date::date) FILTER (WHERE a.punch_out_time IS NOT NULL) AS days_marked,
          MAX(a.punch_in_time) FILTER (WHERE a.punch_in_time IS NOT NULL) AS punch_in_time,
          MAX(a.mid_shift_punch_in_time) FILTER (WHERE a.mid_shift_punch_in_time IS NOT NULL) AS mid_shift_punch_in_time,
          MAX(a.punch_out_time) FILTER (WHERE a.punch_out_time IS NOT NULL) AS punch_out_time,
          MAX(
            CASE
              WHEN a.punch_out_time IS NOT NULL THEN a.punch_out_time
              WHEN a.mid_shift_punch_in_time IS NOT NULL THEN a.mid_shift_punch_in_time
              WHEN a.punch_in_time IS NOT NULL THEN a.punch_in_time
              ELSE NULL
            END
          ) AS last_punch_time
        FROM attendance a
        JOIN scoped_employees se ON se.emp_id = a.emp_id
        WHERE a.date::date BETWEEN $1::date AND $2::date
        GROUP BY a.emp_id
      ),
      ward_supervisors AS (
        SELECT sw2.ward_id, STRING_AGG(su.name, ', ') AS supervisor_names
        FROM supervisor_ward sw2
        JOIN users su ON sw2.supervisor_id = su.user_id
        GROUP BY sw2.ward_id
      )
      SELECT
        se.*,
        ws.supervisor_names AS supervisor_name,
        CASE
          WHEN COALESCE(summary.has_leave, 0) = 1 THEN 'Leave'
          WHEN COALESCE(summary.has_punch_start, 0) = 0 THEN 'Not Marked'
          WHEN COALESCE(summary.has_punch_out, 0) = 1 THEN 'Marked'
          ELSE 'In Progress'
        END AS attendance_status,
        summary.leave_type AS leave_type,
        COALESCE(summary.days_present, 0) AS days_present,
        COALESCE(summary.days_marked, 0) AS days_marked,
        summary.has_punch_in,
        summary.has_mid_shift_punch_in,
        summary.has_punch_start,
        summary.has_punch_out,
        summary.last_punch_time,
        summary.punch_in_time,
        summary.mid_shift_punch_in_time,
        summary.punch_out_time,
        TO_CHAR(summary.punch_in_time, 'HH12:MI AM') AS punch_in_display,
        TO_CHAR((summary.mid_shift_punch_in_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS mid_shift_punch_in_display,
        TO_CHAR(summary.punch_out_time, 'HH12:MI AM') AS punch_out_display,
        COALESCE(
          TO_CHAR(summary.punch_out_time, 'HH12:MI AM'),
          TO_CHAR((summary.mid_shift_punch_in_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM'),
          TO_CHAR(summary.punch_in_time, 'HH12:MI AM')
        ) AS last_punch_display,
        EXTRACT(EPOCH FROM (summary.punch_in_time AT TIME ZONE 'Asia/Kolkata')) AS punch_in_epoch,
        EXTRACT(EPOCH FROM summary.mid_shift_punch_in_time) AS mid_shift_punch_in_epoch,
        EXTRACT(EPOCH FROM (summary.punch_out_time AT TIME ZONE 'Asia/Kolkata')) AS punch_out_epoch,
        COALESCE(
          EXTRACT(EPOCH FROM (summary.punch_out_time AT TIME ZONE 'Asia/Kolkata')),
          EXTRACT(EPOCH FROM summary.mid_shift_punch_in_time),
          EXTRACT(EPOCH FROM (summary.punch_in_time AT TIME ZONE 'Asia/Kolkata'))
        ) AS last_punch_epoch
      FROM scoped_employees se
      LEFT JOIN attendance_summary summary ON summary.emp_id = se.emp_id
      LEFT JOIN ward_supervisors ws ON ws.ward_id = se.ward_id;
    `;
    const res = await pool.query(query, [startDate, endDate]);
    console.log(`Optimized query returned ${res.rows.length} rows`);
  } catch (err) {
    console.error(err);
  }
  console.timeEnd("OptimizedQuery");

  await pool.end();
}

run();
