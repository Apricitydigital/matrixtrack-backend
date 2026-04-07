const fs = require('fs');
const pool = require('./config/db');
(async () => {
  try {
    const today = '2026-03-30';
    const userId = 96; // Pmc Admin

    const qTotal = await pool.query(`
      WITH scoped_employees AS (
        SELECT DISTINCT e.emp_id
        FROM employee e
        JOIN wards w ON e.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
        LEFT JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
        WHERE c.city_name = 'Pune'
          AND (sw.supervisor_id = $2 OR
          w.ward_id IN (SELECT ward_id FROM user_kothi_access WHERE user_id = $2) OR
          w.ward_id IN (SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $2) OR
          w.zone_id IN (SELECT zone_id FROM user_zone_access WHERE user_id = $2))
      )
      SELECT COUNT(*) as count FROM scoped_employees
    `, [today, userId]);

    // Also check how many present
    const qPresent = await pool.query(`
      WITH scoped_employees AS (
        SELECT DISTINCT e.emp_id
        FROM employee e
        JOIN wards w ON e.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
        LEFT JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
        WHERE c.city_name = 'Pune'
          AND (sw.supervisor_id = $2 OR
          w.ward_id IN (SELECT ward_id FROM user_kothi_access WHERE user_id = $2) OR
          w.ward_id IN (SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $2) OR
          w.zone_id IN (SELECT zone_id FROM user_zone_access WHERE user_id = $2))
      )
      SELECT COUNT(DISTINCT a.emp_id) as count
      FROM scoped_employees se
      JOIN attendance a ON a.emp_id = se.emp_id
      WHERE a.date::date = $1 
      AND a.punch_in_time IS NOT NULL
    `, [today, userId]);

    fs.writeFileSync('test_scope.txt', \`Pmc Admin Scoped Total: \${qTotal.rows[0].count}\\nPmc Admin Scoped Present: \${qPresent.rows[0].count}\`);
  } catch(e) { console.error(e); } finally { process.exit(0); }
})();
