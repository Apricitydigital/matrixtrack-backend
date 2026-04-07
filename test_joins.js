const fs = require('fs');
const pool = require('./config/db');
(async () => {
  try {
    const today = '2026-03-30';
    let out = [];
    
    // Total punched in
    const q1 = await pool.query(`SELECT count(*) FROM attendance WHERE date::date = $1 AND punch_in_time IS NOT NULL`, [today]);
    out.push("Total punched in today (attendance table): " + q1.rows[0].count);

    // How many of these punched-in employees are in Pune?
    const q2 = await pool.query(`
      SELECT COUNT(DISTINCT a.emp_id) 
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE a.date::date = $1 
      AND a.punch_in_time IS NOT NULL
      AND c.city_name = 'Pune'
    `, [today]);
    out.push("Punched in AND properly linked to Pune (INNER JOINs): " + q2.rows[0].count);

    // How many in DB vs joined?
    const q3 = await pool.query(`
      SELECT COUNT(DISTINCT e.emp_id)
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = 'Pune'
    `);
    out.push("Total employees properly linked to Pune (INNER JOINs): " + q3.rows[0].count);

    fs.writeFileSync('test_joins_out2.txt', out.join('\n'));
  } catch(e) { console.error(e); fs.writeFileSync('test_joins_out2.txt', e.toString()); } finally { process.exit(0); }
})();
