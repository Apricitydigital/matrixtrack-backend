const pool = require('./config/db.js');
const fs = require('fs');

async function check() {
  let out = '';
  const { rows: neeraj } = await pool.query(`SELECT emp_id, emp_code, name, face_embedding FROM employee WHERE name ILIKE '%Neeraj verma%'`);
  out += `Neeraj:\n${JSON.stringify(neeraj, null, 2)}\n\n`;

  const { rows: chhaya } = await pool.query(`SELECT emp_id, emp_code, name, face_embedding FROM employee WHERE name ILIKE '%CHHAYA GARDE%'`);
  out += `Chhaya:\n${JSON.stringify(chhaya, null, 2)}\n\n`;

  fs.writeFileSync('db_out7.txt', out);
}
check().catch(console.error).finally(() => process.exit(0));
