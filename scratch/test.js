const pool = require('../config/db');

async function test() {
  try {
    const res = await pool.query(`
      EXPLAIN ANALYZE
      SELECT
        TO_CHAR(date, 'YYYY-MM') AS month,
        COUNT(*)::bigint AS records
      FROM attendance
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    `);
    console.log(res.rows.map(r => r['QUERY PLAN']).join('\n'));
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

test();
