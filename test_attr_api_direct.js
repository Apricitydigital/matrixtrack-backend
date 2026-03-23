const axios = require('axios');
(async () => {
    try {
        // Find token logic or just inject a token middleware locally in the script!
        // I will just use the exact logic of the route without the HTTP! Yes!
        const pool = require('./config/db');
        const req = {
            query: { date: '2026-03-23' },
            cityScope: { all: true, ids: [] },
            kothiScope: { all: true, ids: [] },
        };
        const date = req.query.date;
        const { buildCityFilterClause } = require("./middleware/cityScope");
        const { buildKothiFilterClause } = require("./middleware/kothiScope");

        const cityFilter = buildCityFilterClause(req.cityScope, "c", [date]);
        const kothiFilter = buildKothiFilterClause(req.kothiScope, "w", cityFilter.params);

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
                dept.department_name AS department,
                des.designation_name AS designation,
                e.phone AS contact_no, 
                TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in, 
                a.in_address, 
                a.punch_in_image, 
                TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out, 
                a.out_address, 
                a.punch_out_image, 
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
            WHERE a.date = $1
                ${cityFilter.clause} ${kothiFilter.clause}
            ORDER BY a.date DESC, a.attendance_id;`,
            kothiFilter.params
        );
        console.log("length:", result.rows.length);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
