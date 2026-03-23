const pool = require('./config/db');
(async () => {
    try {
        const query = `
        SELECT count(*)
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
        `;
        const res = await pool.query(query, ['2026-03-23']);
        console.log("query result count:", res.rows[0].count);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
})();
