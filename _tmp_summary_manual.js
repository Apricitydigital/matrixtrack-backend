const pool=require('./config/db');
(async()=>{
  const start='2026-03-24';
  const end='2026-03-24';
  const params=[];
  const baseFilters=[];
  // no city, no zone, no kothi
  const startParam=params.length+1;
  const endParam=params.length+2;
  const whereClause=baseFilters.length?`WHERE ${baseFilters.join(' AND ')}`:'';
  const sql=`WITH scoped_employees AS (
      SELECT DISTINCT e.emp_id
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN supervisor_ward sw ON w.ward_id = sw.ward_id
      ${whereClause}
    ),
    attendance_status AS (
      SELECT
        se.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_in,
        MAX(CASE WHEN a.leave_type IS NOT NULL THEN 1 ELSE 0 END) AS has_leave,
        MAX(CASE WHEN a.punch_out_time IS NOT NULL THEN 1 ELSE 0 END) AS has_punch_out
      FROM scoped_employees se
      LEFT JOIN attendance a
        ON a.emp_id = se.emp_id
       AND a.date::date BETWEEN $${startParam}::date AND $${endParam}::date
      GROUP BY se.emp_id
    )
    SELECT
      (SELECT COUNT(*) FROM scoped_employees) AS total_employees,
      COALESCE(SUM(CASE WHEN has_punch_in = 1 THEN 1 ELSE 0 END), 0) AS present
    FROM attendance_status;`;
  params.push(start,end);
  const {rows}=await pool.query(sql,params);
  console.log(rows[0]);
  await pool.end();
})();
