const pool=require("./config/db");
(async()=>{
  const {rows}=await pool.query(`
    select face_embedding, array_agg(emp_id) emp_ids, count(*) c
    from employee
    where face_embedding is not null
    group by face_embedding
    having count(*)>1
    order by c desc
    limit 20
  `);
  console.log(rows);
  await pool.end();
})();
