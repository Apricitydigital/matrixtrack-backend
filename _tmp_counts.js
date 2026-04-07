const pool=require('./config/db');
(async()=>{
  const total=await pool.query('select count(*)::int as c from employee');
  console.log('employee total', total.rows[0]);
  const today='2026-03-24';
  const present=await pool.query('select count(*)::int as c from attendance where date::date=$1 and punch_in_time is not null',[today]);
  console.log('present today', present.rows[0]);
  await pool.end();
})();
