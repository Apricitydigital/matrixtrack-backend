require('dotenv').config();
const pool = require('./config/db');

async function main() {
    const cityName = 'Indore'; 
    const zoneName = 'Zone 1';
    const targetDate = '2026-04-09';
    const params = [cityName, zoneName, targetDate];
    let extraClause = "";

    try {
        const queryText = `SELECT
        c.city_name,
        z.zone_name,
        s.sector_name                                    AS ward_name,
        w.ward_name                                      AS kothi_name,
        COALESCE(
          STRING_AGG(DISTINCT u.name, ', ' ORDER BY u.name), ''
        )                                                AS supervisor_names,
        COALESCE(
          STRING_AGG(DISTINCT dept.department_name, ', ' ORDER BY dept.department_name), ''
        )                                                AS departments,
        COUNT(DISTINCT e.emp_id)                         AS total_registered_employees,
        COUNT(
          DISTINCT CASE
            WHEN a.punch_in_time IS NOT NULL THEN e.emp_id
          END
        )                                                AS total_present_employees,
        COUNT(
          DISTINCT CASE
            WHEN a.leave_type IS NOT NULL THEN e.emp_id
          END
        )                                                AS total_leave_employees,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.emp_id), NULL) AS registered_emp_ids,
        ARRAY_REMOVE(
          ARRAY_AGG(DISTINCT CASE
            WHEN a.punch_in_time IS NOT NULL THEN e.emp_id
          END),
          NULL
        )                                                AS present_emp_ids,
        ARRAY_REMOVE(
          ARRAY_AGG(DISTINCT CASE
            WHEN a.leave_type IS NOT NULL THEN e.emp_id
          END),
          NULL
        )                                                AS leave_emp_ids
      FROM public.wards w
      JOIN public.zones          z    ON w.zone_id   = z.zone_id
      JOIN public.cities         c    ON z.city_id   = c.city_id
      LEFT JOIN public.sectors   s    ON w.sector_id = s.sector_id
      LEFT JOIN public.employee  e    ON e.ward_id   = w.ward_id
      LEFT JOIN public.designation des ON e.designation_id = des.designation_id
      LEFT JOIN public.department  dept ON des.department_id = dept.department_id
      LEFT JOIN public.supervisor_ward sw ON sw.ward_id = w.ward_id
      LEFT JOIN public.users       u    ON u.user_id   = sw.supervisor_id
      LEFT JOIN public.attendance  a    ON a.emp_id    = e.emp_id AND a.date::date = $3::date
      WHERE c.city_name = $1
        AND z.zone_name = $2
        ${extraClause}
      GROUP BY c.city_name, z.zone_name, s.sector_name, w.ward_id, w.ward_name
      ORDER BY s.sector_name ASC NULLS LAST, w.ward_name ASC`;

        console.log('Running optimized query...');
        const start = Date.now();
        const { rows } = await pool.query(queryText, params);
        const end = Date.now();
        console.log(`SUCCESS. Rows: ${rows.length}, Time: ${end - start}ms`);
    } catch (err) {
        console.error('SQL ERROR:', err.message);
    } finally {
        await pool.end();
    }
}
main();
