const pool = require('../config/db');

async function test() {
  try {
    const res = await pool.query("SELECT * FROM city_daily_traffic_cost ORDER BY id DESC");
    console.log("--- ALL TRAFFIC COST ROWS ---");
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
test();
