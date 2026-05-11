const pool = require("../config/db");

async function checkPooja() {
  const email = 'pooja.sanke@swachcoop.com';
  try {
    console.log(`Checking user with email: ${email}`);
    
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      console.log("User not found in 'users' table.");
    } else {
      console.log("User Info:");
      console.table(userRes.rows);
      
      const userId = userRes.rows[0].user_id;
      
      console.log("\nChecking City Access:");
      const cityAccess = await pool.query('SELECT * FROM user_city_access WHERE user_id = $1', [userId]);
      console.table(cityAccess.rows);
      
      console.log("\nChecking Ward Assignments (supervisor_ward):");
      const assignmentRes = await pool.query(`
        SELECT sw.*, w.ward_name
        FROM supervisor_ward sw
        LEFT JOIN wards w ON sw.ward_id = w.ward_id
        WHERE sw.supervisor_id = $1
      `, [userId]);
      console.table(assignmentRes.rows);

      console.log("\nChecking columns of user_city_access:");
      const ucaCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'user_city_access'");
      console.log(ucaCols.rows.map(r => r.column_name).join(", "));

      console.log("\nListing all tables for reference:");
      const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      console.log(tables.rows.map(r => r.table_name).join(", "));
    }
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkPooja();
