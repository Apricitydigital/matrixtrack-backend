const pool = require('../config/db');

async function inspect() {
  try {
    const res = await pool.query(
      `SELECT a.attendance_id, a.emp_id, e.name, a.date, a.punch_in_time, a.mid_shift_punch_in_time, a.punch_out_time,
              e.ward_id, w.ward_name, z.zone_name, c.city_id, c.city_name
       FROM attendance a
       JOIN employee e ON e.emp_id = a.emp_id
       LEFT JOIN wards w ON w.ward_id = e.ward_id
       LEFT JOIN zones z ON z.zone_id = w.zone_id
       LEFT JOIN cities c ON c.city_id = z.city_id
       ORDER BY a.attendance_id DESC LIMIT 20`
    );
    console.log("--- RECENT ATTENDANCE RECORDS ---");
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
inspect();
