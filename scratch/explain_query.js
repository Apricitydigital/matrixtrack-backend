const pool = require("../config/db");

async function run() {
  const today = new Date().toISOString().slice(0, 10);
  
  try {
    console.log("EXPLAIN with casting (a.date::date):");
    const q1 = `
      EXPLAIN ANALYZE
      SELECT COUNT(*)
      FROM attendance a
      WHERE a.date::date BETWEEN $1::date AND $2::date
    `;
    const res1 = await pool.query(q1, [today, today]);
    console.log(res1.rows.map(r => r['QUERY PLAN']).join('\n'));

    console.log("\nEXPLAIN without casting (a.date):");
    const q2 = `
      EXPLAIN ANALYZE
      SELECT COUNT(*)
      FROM attendance a
      WHERE a.date BETWEEN $1::date AND $2::date
    `;
    const res2 = await pool.query(q2, [today, today]);
    console.log(res2.rows.map(r => r['QUERY PLAN']).join('\n'));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
