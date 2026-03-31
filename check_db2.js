const pool = require('./config/db.js');
const fs = require('fs');

async function run() {
  const names = ['Ishika', 'Jaspreet', 'sunpreet', 'Neeraj'];
  let out = '';
  for (const name of names) {
    const res = await pool.query(`SELECT emp_id, emp_code, name, face_embedding FROM employee WHERE name ILIKE $1`, [`%${name}%`]);
    out += `Results for ${name}:\n`;
    out += JSON.stringify(res.rows, null, 2) + '\n';
    out += '---\n';
  }
  fs.writeFileSync('db_out.txt', out);
}

run()
  .catch(console.error)
  .finally(() => process.exit(0));
