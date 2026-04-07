const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'matrixtrack_db',
  password: process.env.DB_PASSWORD || '12345',
  port: process.env.DB_PORT || 5432,
});

async function test() {
  const query = `
      SELECT 
        c.city_id,
        z.zone_id,
        s.sector_id,
        w.ward_id,
        c.city_name,
        z.zone_name,
        s.sector_name AS ward_name,
        w.ward_name AS kothi_name,
        u.name AS supervisor_name
      FROM users u
      JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
      JOIN wards w ON sw.ward_id = w.ward_id
      LEFT JOIN sectors s ON w.sector_id = s.sector_id
      LEFT JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN cities c ON z.city_id = c.city_id
      WHERE u.role = 'supervisor';
  `;
  try {
    const res = await pool.query(query);
    console.log("Returned rows:", res.rows.length);
    if(res.rows.length > 0) {
      console.log(res.rows[0]);
      console.log("Cities present (w.zone_id):", [...new Set(res.rows.map(r => r.city_name))]);
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
test();
