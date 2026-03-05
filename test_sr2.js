require('dotenv').config();
const pool = require('./config/db');
async function main() {
    try {
        const r1 = await pool.query(`SELECT c.city_id, c.city_name FROM cities c ORDER BY city_name LIMIT 10`);
        console.log('Cities:', r1.rows.map(r => `${r.city_id}: ${r.city_name}`).join(', '));

        const r2 = await pool.query(`SELECT z.zone_id, z.zone_name FROM zones z JOIN cities c ON z.city_id=c.city_id WHERE c.city_name='Pune' LIMIT 10`);
        console.log('Pune Zones:', r2.rows.map(r => `${r.zone_id}: ${r.zone_name}`));

        // Now try the actual short-report query with city_id instead of name
        const r3 = await pool.query(`
      SELECT w.ward_name AS kothi_name, s.sector_name AS ward_name,
             COUNT(DISTINCT e.emp_id) AS total_registered
      FROM public.wards w
      JOIN public.zones z ON w.zone_id = z.zone_id
      JOIN public.cities c ON z.city_id = c.city_id
      LEFT JOIN public.sectors s ON w.sector_id = s.sector_id
      LEFT JOIN public.employee e ON e.ward_id = w.ward_id
      WHERE c.city_name = 'Pune'
      GROUP BY w.ward_id, w.ward_name, s.sector_name
      LIMIT 5
    `);
        console.log('Sample kothis:', r3.rows);
    } catch (e) {
        console.error('ERR:', e.message);
    } finally {
        await pool.end();
    }
}
main();
