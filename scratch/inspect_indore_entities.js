const pool = require('../config/db');

async function inspect() {
  try {
    const citiesRes = await pool.query("SELECT city_id, city_name FROM cities ORDER BY city_id");
    console.log("--- CITIES ---");
    console.log(citiesRes.rows);

    const configRes = await pool.query(
      `SELECT cbc.city_id, c.city_name, cbc.partner_name, cbc.billing_model
       FROM city_billing_configs cbc
       JOIN cities c ON c.city_id = cbc.city_id`
    );
    console.log("--- BILLING CONFIGS ---");
    console.log(configRes.rows);

    const indoreEmpRes = await pool.query(
      `SELECT e.emp_id, e.name, e.ward_id, w.ward_name, z.zone_name, c.city_name
       FROM employee e
       JOIN wards w ON w.ward_id = e.ward_id
       JOIN zones z ON z.zone_id = w.zone_id
       JOIN cities c ON c.city_id = z.city_id
       WHERE c.city_name ILIKE '%indore%'
       ORDER BY e.emp_id DESC LIMIT 10`
    );
    console.log("--- INDORE EMPLOYEES ---");
    console.log(indoreEmpRes.rows);

    const indoreSupRes = await pool.query(
      `SELECT DISTINCT u.user_id, u.name, u.email
       FROM users u
       JOIN supervisor_ward sw ON sw.supervisor_id = u.user_id
       JOIN wards w ON w.ward_id = sw.ward_id
       JOIN zones z ON z.zone_id = w.zone_id
       JOIN cities c ON c.city_id = z.city_id
       WHERE c.city_name ILIKE '%indore%'`
    );
    console.log("--- INDORE SUPERVISORS ---");
    console.log(indoreSupRes.rows);

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
inspect();
