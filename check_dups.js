const pool = require('./config/db.js');
const fs = require('fs');
async function checkDuplicates() {
  const targets = ['8956', '9726']; // Ishika and Sunpreet
  let out = '';
  for (const empId of targets) {
    const { rows } = await pool.query(`SELECT emp_code FROM employee WHERE emp_id = $1`, [empId]);
    const empCode = rows.length ? rows[0].emp_code : null;
    out += `Checking duplicates for emp_id ${empId} (code: ${empCode})\n`;
    if (empCode) {
      const { rows: dups } = await pool.query(`
        SELECT emp_id, face_embedding 
        FROM employee 
        WHERE emp_code = $1 AND face_embedding IS NOT NULL
      `, [empCode]);
      out += `Found ${dups.length} entries with this emp_code:\n`;
      dups.forEach(d => out += ` - emp_id: ${d.emp_id}, face_embedding: ${d.face_embedding}\n`);
    }
  }
  fs.writeFileSync('db_out6.txt', out);
}
checkDuplicates().catch(console.error).finally(() => process.exit(0));
