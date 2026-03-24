const pool=require('./config/db');
(async()=>{
  const city=await pool.query("select city_id from cities where lower(city_name)='pune' limit 1");
  console.log(city.rows);
  await pool.end();
})();
