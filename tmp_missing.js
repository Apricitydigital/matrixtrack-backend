const pool=require("./config/db");
(async()=>{
  const {rows}=await pool.query(`
    select e.emp_id, e.emp_code, e.name
      from employee e
      join supervisor_ward sw on sw.ward_id = e.ward_id
     where sw.supervisor_id = $1
       and e.face_embedding is null
  `,[119]);
  console.log(rows);
  await pool.end();
})();
