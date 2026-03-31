const fs = require('fs');
const pool = require('./config/db');
(async () => {
  try {
    const today = '2026-03-30';
    let out = [];
    out.push(`Checking DB for ${today}...`);

    const q1 = await pool.query(`SELECT count(*) as count FROM attendance WHERE date::date = $1`, [today]);
    out.push(`Attendance records using date::date: ${q1.rows[0].count}`);

    const q2 = await pool.query(`SELECT count(*) as count FROM attendance WHERE (date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = $1`, [today]);
    out.push(`Attendance records using AT TIME ZONE: ${q2.rows[0].count}`);

    const q3 = await pool.query(`SELECT count(*) as has_punch_in FROM attendance WHERE date::date = $1 AND punch_in_time IS NOT NULL`, [today]);
    out.push(`Punch-in records for date::date: ${q3.rows[0].has_punch_in}`);

    const q3b = await pool.query(`SELECT count(*) as has_punch_in FROM attendance WHERE (date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = $1 AND punch_in_time IS NOT NULL`, [today]);
    out.push(`Punch-in records for AT TIME ZONE: ${q3b.rows[0].has_punch_in}`);

    const q4 = await pool.query(`SELECT count(*) as count FROM employee`);
    out.push(`Total DB employees: ${q4.rows[0].count}`);

    fs.writeFileSync('db_test_output.txt', out.join('\n'));
  } catch(e) {
    fs.writeFileSync('db_test_output.txt', e.toString());
  } finally {
    process.exit(0);
  }
})();
