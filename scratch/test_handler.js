const pool = require("../config/db");
const start = "2026-05-14";
const end = "2026-06-06";
const cityId = "all";
const zoneId = "all";
const sectorId = "all";
const wardId = "all";

async function test() {
  try {
    const sDate = new Date(start);
    const eDate = new Date(end);
    const utc1 = Date.UTC(sDate.getUTCFullYear(), sDate.getUTCMonth(), sDate.getUTCDate());
    const utc2 = Date.UTC(eDate.getUTCFullYear(), eDate.getUTCMonth(), eDate.getUTCDate());
    const diffDays = Math.abs(Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24)));
    
    if (diffDays > 45) {
      console.log("Date range cannot exceed 45 days");
      return;
    }

    const scope = { all: true, ids: [] }; // Mock superadmin scope
    const cityIdsScope = scope.all ? null : (scope.ids || []).map(Number);

    const cityIdFilter = cityId && cityId !== "all" && cityId !== "undefined" ? Number(cityId) : null;
    const zoneIdFilter = zoneId && zoneId !== "all" && zoneId !== "undefined" ? Number(zoneId) : null;
    const sectorIdFilter = sectorId && sectorId !== "all" && sectorId !== "undefined" ? Number(sectorId) : null;
    const wardIdFilter = wardId && wardId !== "all" && wardId !== "undefined" ? Number(wardId) : null;

    const queryParams = [
      start,
      end,
      cityIdFilter,
      cityIdsScope,
      zoneIdFilter,
      sectorIdFilter,
      wardIdFilter
    ];

    const query = `
      WITH date_series AS (
        SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS report_date
      ),
      supervisors AS (
        SELECT 
          u.user_id,
          u.name AS supervisor_name,
          u.phone AS supervisor_phone,
          c.city_name,
          c.city_id,
          STRING_AGG(DISTINCT z.zone_name, ', ') AS zones,
          STRING_AGG(DISTINCT w.ward_name, ', ') AS kothis
        FROM users u
        LEFT JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
        LEFT JOIN wards w ON sw.ward_id = w.ward_id
        LEFT JOIN sectors s ON w.sector_id = s.sector_id
        LEFT JOIN zones z ON s.zone_id = z.zone_id
        LEFT JOIN cities c ON z.city_id = c.city_id
        WHERE u.role = 'supervisor'
          AND ($3::int IS NULL OR c.city_id = $3::int)
          AND ($4::int[] IS NULL OR c.city_id = ANY($4::int[]))
          AND ($5::int IS NULL OR z.zone_id = $5::int)
          AND ($6::int IS NULL OR s.sector_id = $6::int)
          AND ($7::int IS NULL OR w.ward_id = $7::int)
        GROUP BY u.user_id, u.name, u.phone, c.city_name, c.city_id
      ),
      daily_actions AS (
        SELECT 
          d.report_date,
          sup.user_id,
          COUNT(DISTINCT a.attendance_id) FILTER (WHERE a.punched_in_by = sup.user_id) AS punch_in_count,
          COUNT(DISTINCT a.attendance_id) FILTER (WHERE a.punched_out_by = sup.user_id) AS punch_out_count,
          COUNT(DISTINCT a.attendance_id) FILTER (WHERE a.mid_shift_punched_in_by = sup.user_id) AS mid_shift_count,
          COUNT(DISTINCT a.attendance_id) FILTER (WHERE a.leave_marked_by = sup.user_id) AS leave_count,
          STRING_AGG(DISTINCT emp.name || ' (' || emp.emp_code || ')', ', ') FILTER (WHERE a.punched_in_by = sup.user_id) AS punch_in_employees,
          STRING_AGG(DISTINCT emp.name || ' (' || emp.emp_code || ')', ', ') FILTER (WHERE a.punched_out_by = sup.user_id) AS punch_out_employees,
          STRING_AGG(DISTINCT emp.name || ' (' || emp.emp_code || ')', ', ') FILTER (WHERE a.mid_shift_punched_in_by = sup.user_id) AS mid_shift_employees,
          STRING_AGG(DISTINCT emp.name || ' (' || emp.emp_code || ')', ', ') FILTER (WHERE a.leave_marked_by = sup.user_id) AS leave_employees
        FROM date_series d
        CROSS JOIN supervisors sup
        LEFT JOIN attendance a ON a.date::date = d.report_date 
          AND (
            a.punched_in_by = sup.user_id 
            OR a.punched_out_by = sup.user_id 
            OR a.mid_shift_punched_in_by = sup.user_id 
            OR a.leave_marked_by = sup.user_id
          )
        LEFT JOIN employee emp ON a.emp_id = emp.emp_id
        GROUP BY d.report_date, sup.user_id
      )
      SELECT 
        s.user_id AS supervisor_id,
        s.supervisor_name,
        s.supervisor_phone,
        s.city_id,
        s.city_name,
        s.zones,
        s.kothis,
        COUNT(da.report_date) AS total_days,
        COUNT(CASE WHEN (da.punch_in_count > 0 OR da.punch_out_count > 0 OR da.mid_shift_count > 0 OR da.leave_count > 0) THEN 1 END) AS present_days,
        COUNT(CASE WHEN COALESCE(da.punch_in_count, 0) = 0 AND COALESCE(da.punch_out_count, 0) = 0 AND COALESCE(da.mid_shift_count, 0) = 0 AND COALESCE(da.leave_count, 0) = 0 THEN 1 END) AS absent_days,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'date', TO_CHAR(da.report_date, 'YYYY-MM-DD'),
            'status', CASE WHEN (da.punch_in_count > 0 OR da.punch_out_count > 0 OR da.mid_shift_count > 0 OR da.leave_count > 0) THEN 'Present' ELSE 'Absent' END,
            'punch_in_count', COALESCE(da.punch_in_count, 0),
            'punch_out_count', COALESCE(da.punch_out_count, 0),
            'mid_shift_count', COALESCE(da.mid_shift_count, 0),
            'leave_count', COALESCE(da.leave_count, 0),
            'punch_in_employees', COALESCE(da.punch_in_employees, ''),
            'punch_out_employees', COALESCE(da.punch_out_employees, ''),
            'mid_shift_employees', COALESCE(da.mid_shift_employees, ''),
            'leave_employees', COALESCE(da.leave_employees, '')
          ) ORDER BY da.report_date ASC
        ) AS daily_history
      FROM supervisors s
      LEFT JOIN daily_actions da ON s.user_id = da.user_id
      GROUP BY 
        s.user_id, s.supervisor_name, s.supervisor_phone, 
        s.city_id, s.city_name, s.zones, s.kothis
      ORDER BY s.supervisor_name;
    `;

    console.log("Running query...");
    const res = await pool.query(query, queryParams);
    console.log("Success! Total rows fetched:", res.rows.length);
    // Find a record with active actions to print
    const recordWithActions = res.rows.find(r => r.present_days > 0);
    if (recordWithActions) {
      console.log('Sample Row with Action:', JSON.stringify(recordWithActions, null, 2));
    } else {
      console.log('No supervisor records had activity in this range.');
    }
    process.exit(0);
  } catch (err) {
    console.error("CRITICAL QUERY ERROR:", err);
    process.exit(1);
  }
}

test();
