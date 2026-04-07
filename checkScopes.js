const pool=require("./config/db");
(async()=>{
  const r1=await pool.query("select ward_id from supervisor_ward where supervisor_id=(select user_id from users where email='ashu@gmail.com')");
  const r2=await pool.query("select ward_id from user_kothi_access where user_id=(select user_id from users where email='ashu@gmail.com')");
  const r3=await pool.query("select zone_id from user_zone_access where user_id=(select user_id from users where email='ashu@gmail.com')");
  console.log({supervisor_ward:r1.rows.length,user_kothi:r2.rows.length,user_zone:r3.rows.length});
  pool.end();
})();
