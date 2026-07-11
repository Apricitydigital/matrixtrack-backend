const pool = require('../config/db');

async function test() {
  try {
    const res = await pool.query(
      `SELECT c.city_name, COUNT(*)::int AS count
       FROM attendance a
       JOIN employee e ON e.emp_id = a.emp_id
       JOIN wards w ON w.ward_id = e.ward_id
       JOIN zones z ON z.zone_id = w.zone_id
       JOIN cities c ON c.city_id = z.city_id
       WHERE a.date >= '2026-07-08'::date
       GROUP BY c.city_name`
    );
    console.log("--- ATTENDANCE BY CITY FROM 2026-07-08 ---");
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
test();
