const pool=require("./config/db");
(async()=>{
  const {rows}=await pool.query('select emp_id, face_embedding, face_id, face_confidence from employee where emp_id=$1',[11260]);
  console.log(rows);
  await pool.end();
})();
