const pool = require("./config/db");

async function checkDatabase() {
    try {
        const result = await pool.query("SELECT * FROM geofencing_requests");
        console.log("Current Geofence Requests in Database:");
        console.table(result.rows);
    } catch (error) {
        console.error("Error checking database:", error);
    } finally {
        process.exit();
    }
}

checkDatabase();
