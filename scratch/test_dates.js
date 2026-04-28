const pool = require('../config/db');

async function test() {
  try {
    const q15 = `SELECT count(*) FROM attendance WHERE date::date = '2026-04-15'`;
    const r15 = await pool.query(q15);
    console.log("Count for 2026-04-15:", r15.rows[0].count);

    const q16 = `SELECT count(*) FROM attendance WHERE date::date = '2026-04-16'`;
    const r16 = await pool.query(q16);
    console.log("Count for 2026-04-16:", r16.rows[0].count);

    const q15T = `SELECT count(*) FROM attendance WHERE date = '2026-04-15T18:30:00.000Z'`;
    const r15T = await pool.query(q15T);
    console.log("Count exact 2026-04-15T18:30:00.000Z:", r15T.rows[0].count);

    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

test();
