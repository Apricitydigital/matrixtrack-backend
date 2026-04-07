require("dotenv").config();
const pool=require("./config/db");
const { parseFaceKey } = require("./utils/faceImage");

(async()=>{
  const dupQuery = `
    SELECT face_embedding, array_agg(emp_id) emp_ids
    FROM employee
    WHERE face_embedding IS NOT NULL
    GROUP BY face_embedding
    HAVING COUNT(*)>1;
  `;
  const {rows} = await pool.query(dupQuery);
  let cleared=0, kept=0;
  for (const row of rows) {
    const key = parseFaceKey(row.face_embedding);
    const ids = row.emp_ids;
    let canonical = null;
    if (key) {
      const m = key.match(/^faces\/(\d+)/);
      if (m) {
        const folderId = Number(m[1]);
        if (ids.includes(folderId)) {
          canonical = folderId;
        }
      }
    }
    if (canonical === null) {
      canonical = Math.min(...ids);
    }
    const toNull = ids.filter(id => id !== canonical);
    if (toNull.length) {
      await pool.query('UPDATE employee SET face_embedding = NULL WHERE emp_id = ANY($1)', [toNull]);
      cleared += toNull.length;
    }
    kept++;
  }
  console.log({ groups: rows.length, cleared, kept });
  await pool.end();
})();
