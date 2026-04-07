const pool=require("./config/db");(async()=>{
  const res=await pool.query('select emp_id,emp_code,name,face_embedding from employee where emp_code in ($1,$2,$3)',["2345","EMP2023","EMP2025"]);
  console.log(res.rows);
  await pool.end();
})();
