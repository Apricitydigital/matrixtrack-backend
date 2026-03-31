const pool = require('./config/db');
(async () => {
  try {
    const res = await pool.query("SELECT * FROM users WHERE name = 'Pmc Admin' OR user_id = 90 OR role = 'admin' LIMIT 5");
    console.log(res.rows);
  } catch(e) { console.error(e); } finally { process.exit(0); }
})();
