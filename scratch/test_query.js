const pool = require('../config/db');
pool.query(`
  SELECT 
    u.user_id,
    u.name AS supervisor_name,
    c.city_name
  FROM users u
  LEFT JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
  LEFT JOIN wards w ON sw.ward_id = w.ward_id
  LEFT JOIN sectors s ON w.sector_id = s.sector_id
  LEFT JOIN zones z ON s.zone_id = z.zone_id
  LEFT JOIN cities c ON z.city_id = c.city_id
  WHERE u.role = 'supervisor'
  LIMIT 5
`).then(res => {
  console.log('SUCCESS:', res.rows);
  process.exit(0);
}).catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
