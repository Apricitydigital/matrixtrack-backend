const pool = require('./config/db');
(async () => {
    try {
        const query = `
        SELECT count(*)
        FROM attendance a
        WHERE a.date = $1
        `;
        const res = await pool.query(query, ['23-03-2026']);
        console.log("query result count:", res.rows[0].count);
        process.exit(0);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
})();
