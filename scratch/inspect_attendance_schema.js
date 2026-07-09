const pool = require('../config/db');

async function test() {
  try {
    const res = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'attendance'
       ORDER BY ordinal_position`
    );
    console.log("--- ATTENDANCE TABLE COLUMNS ---");
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
test();
