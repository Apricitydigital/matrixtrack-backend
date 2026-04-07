const pool=require("./config/db");
(async()=>{
  const {rows}=await pool.query('select user_id,email,name,phone,role from users where user_id=$1',[119]);
  console.log(rows);
  await pool.end();
})();
