const pool = require('./config/db');
(async () => {
    const res = await pool.query('SELECT COUNT(*) FROM attendance WHERE date = CURRENT_DATE AND ward_id IS NULL');
    console.log("null ward_ids:", res.rows[0].count);
    const res2 = await pool.query('SELECT COUNT(*) FROM attendance WHERE date = CURRENT_DATE AND ward_id IS NOT NULL');
    console.log("not null ward_ids:", res2.rows[0].count);
    process.exit(0);
})();
