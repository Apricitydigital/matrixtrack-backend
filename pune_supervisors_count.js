const pool = require('./config/db');

async function puneSupervisorsCount() {
  try {
    // Count of supervisors in Pune
    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT u.user_id) AS supervisor_count
      FROM users u
      JOIN user_city_access uca ON u.user_id = uca.user_id
      JOIN cities c ON uca.city_id = c.city_id
      WHERE u.role = 'supervisor'
        AND LOWER(c.city_name) = 'pune';
    `);

    console.log('=== Pune Supervisors Count ===');
    console.log('Total Supervisors in Pune:', countResult.rows[0].supervisor_count);

    // Detailed list
    const listResult = await pool.query(`
      SELECT DISTINCT u.user_id, u.name, u.role, c.city_name
      FROM users u
      JOIN user_city_access uca ON u.user_id = uca.user_id
      JOIN cities c ON uca.city_id = c.city_id
      WHERE u.role = 'supervisor'
        AND LOWER(c.city_name) = 'pune'
      ORDER BY u.name;
    `);

    console.log('\n=== Supervisor List ===');
    console.table(listResult.rows);

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

puneSupervisorsCount();
