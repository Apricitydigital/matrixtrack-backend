const pool=require('./config/db');
const kothis=[618,622,25,26,27,17,83,674,677,679,681,686,689,695,486,22,24,18,20,21,541,542,578,524,540,545,546,547,572,576,577,676,680,688,711,749,750,751,752,753,754,761,762,763,764,765,766,767,768,769,773,774,710,713,712,714,716,23];
const date='2026-03-24';
(async()=>{
  const baseFilters=['w.ward_id = ANY($1::int[])'];
  const params=[kothis];
  const where=`WHERE ${baseFilters.join(' AND ')}`;
  const sql=`WITH scoped_employees AS (
      SELECT e.emp_id
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      ${where}
    ), attendance_status AS (
      SELECT se.emp_id,
             MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
             MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
             MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out
      FROM scoped_employees se
      LEFT JOIN attendance a ON a.emp_id = se.emp_id AND a.date::date BETWEEN $${params.length+1}::date AND $${params.length+2}::date
      GROUP BY se.emp_id
    )
    SELECT
      (SELECT COUNT(*) FROM scoped_employees) AS total_employees,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) AS present,
      COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0) AS on_leave,
      COALESCE(SUM(CASE WHEN has_punch_out = 1 THEN 1 ELSE 0 END), 0) AS fully_marked,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 AND has_punch_out = 0 THEN 1 ELSE 0 END), 0) AS in_progress,
      GREATEST((SELECT COUNT(*) FROM scoped_employees) - COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) - COALESCE(SUM(CASE WHEN has_leave = 1 THEN 1 ELSE 0 END), 0), 0) AS not_marked
    FROM attendance_status;`;
  params.push(date,date);
  const {rows}=await pool.query(sql,params);
  console.log(rows[0]);
  await pool.end();
})();
