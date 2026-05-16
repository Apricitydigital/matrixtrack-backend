const pool = require('../config/db');
pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'", (err, res) => {
  if (err) {
    console.error(err);
  } else {
    console.log(res.rows.map(r => r.table_name));
  }
  process.exit();
});
