const pool = require('../config/db');

async function run() {
  try {
    const attendance = await pool.query(
      "SELECT * FROM attendance WHERE emp_id = 11260 AND date = '2026-07-05'"
    );
    console.log('ATTENDANCE FOR 11260:', attendance.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
