const pool = require('./config/db.js');
const fs = require('fs');

async function checkPatterns() {
  const { rows } = await pool.query(`
    SELECT face_embedding 
    FROM employee 
    WHERE face_embedding IS NOT NULL 
    LIMIT 200
  `);
  
  const patterns = new Set();
  rows.forEach(r => {
    let p = r.face_embedding.substring(0, 15);
    patterns.add(p);
  });
  
  fs.writeFileSync('patterns_out.txt', Array.from(patterns).join('\n'));
}

checkPatterns().catch(console.error).finally(() => process.exit(0));
