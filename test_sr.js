require('dotenv').config();
const pool = require('./config/db');

async function main() {
    try {
        const { rows } = await pool.query(
            `SELECT
        c.city_name,
        z.zone_name,
        s.sector_name AS ward_name,
        w.ward_name AS kothi_name,
        COUNT(DISTINCT e.emp_id) AS total_registered_employees,
        COUNT(
          DISTINCT CASE
            WHEN a.date::date = $3::date THEN a.attendance_id
          END
        ) AS total_present_employees
      FROM public.wards w
      JOIN public.zones z ON w.zone_id = z.zone_id
      JOIN public.cities c ON z.city_id = c.city_id
      LEFT JOIN public.sectors s ON w.sector_id = s.sector_id
      LEFT JOIN public.employee e ON e.ward_id = w.ward_id
      LEFT JOIN public.supervisor_ward sw ON sw.ward_id = w.ward_id
      LEFT JOIN public.users u ON u.user_id = sw.supervisor_id
      LEFT JOIN public.attendance a ON a.emp_id = e.emp_id
      WHERE c.city_name = $1
        AND z.zone_name = $2
      GROUP BY c.city_name, z.zone_name, s.sector_name, w.ward_id, w.ward_name
      ORDER BY s.sector_name ASC NULLS LAST, w.ward_name ASC
      LIMIT 5`,
            ['Pune', 'Zone - 1 (Dhole Patil Kshetriya k)', '2026-03-05']
        );
        console.log('SUCCESS. Rows:', rows.length);
        rows.slice(0, 3).forEach(r => console.log(JSON.stringify(r)));
    } catch (err) {
        console.error('SQL ERROR:', err.message);
        console.error('Detail:', err.detail);
    } finally {
        await pool.end();
    }
}
main();
