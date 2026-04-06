require("dotenv").config();
const pool=require("./config/db");
const { parseFaceKey } = require("./utils/faceImage");

(async()=>{
  const {rows}=await pool.query(`select emp_id, emp_code, face_embedding from employee where face_embedding is not null`);
  let cleared=0, kept=0;
  for(const row of rows){
    const key=parseFaceKey(row.face_embedding);
    if(!key) continue;
    const match = key.match(/^faces\/(\d+)\//);
    if(!match) continue;
    const folderId = Number(match[1]);
    if(folderId !== Number(row.emp_id)){
      await pool.query('UPDATE employee SET face_embedding = NULL WHERE emp_id = $1', [row.emp_id]);
      cleared++;
    } else {
      kept++;
    }
  }
  console.log({cleared, kept});
  await pool.end();
  process.exit(0);
})();
