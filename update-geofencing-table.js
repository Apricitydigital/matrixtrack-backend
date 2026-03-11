const pool = require("./config/db");

async function updateGeofencingTable() {
    try {
        await pool.query(`
            ALTER TABLE geofencing ADD COLUMN IF NOT EXISTS ward_id INTEGER REFERENCES wards(ward_id) ON DELETE CASCADE;
        `);
        console.log("Geofencing table updated with ward_id successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Error updating geofencing table:", err);
        process.exit(1);
    }
}

updateGeofencingTable();
