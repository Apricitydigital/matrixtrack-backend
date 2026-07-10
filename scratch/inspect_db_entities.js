const pool = require('../config/db');

async function inspect() {
  try {
    const citiesRes = await pool.query("SELECT city_id, city_name FROM cities ORDER BY city_id");
    console.log("--- CITIES ---");
    console.log(citiesRes.rows);

    const zonesRes = await pool.query("SELECT zone_id, zone_name, city_id FROM zones");
    console.log("--- ZONES ---");
    console.log(zonesRes.rows);

    const configRes = await pool.query("SELECT city_id, partner_name FROM city_billing_configs");
    console.log("--- BILLING CONFIGS ---");
    console.log(configRes.rows);

    const empRes = await pool.query(
      `SELECT e.emp_id, e.name, e.ward_id, w.ward_name, z.zone_name, c.city_name
       FROM employee e
       LEFT JOIN wards w ON w.ward_id = e.ward_id
       LEFT JOIN zones z ON z.zone_id = w.zone_id
       LEFT JOIN cities c ON c.city_id = z.city_id
       ORDER BY e.emp_id DESC LIMIT 20`
    );
    console.log("--- EMPLOYEES ---");
    console.log(empRes.rows);

    const supRes = await pool.query(
      `SELECT u.user_id, u.name, u.role, u.email
       FROM users u
       WHERE u.role = 'supervisor' OR u.email LIKE '%admin%'
       ORDER BY u.user_id`
    );
    console.log("--- USERS ---");
    console.log(supRes.rows);

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
inspect();
