const pool=require("./config/db");
(async()=>{
  const {rows}=await pool.query(`
    select e.emp_id,e.emp_code,e.name,e.face_embedding
    from employee e
    where e.ward_id=91
  `);
  console.log(rows);
  await pool.end();
})();
