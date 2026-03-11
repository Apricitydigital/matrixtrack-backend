const pool = require("./config/db");

async function createGeofencingTable() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS geofencing (
                geofence_id SERIAL PRIMARY KEY,
                zone_id INTEGER REFERENCES zones(zone_id) ON DELETE CASCADE,
                ward_id INTEGER REFERENCES wards(ward_id) ON DELETE CASCADE,
                latitude DECIMAL(10, 8) NOT NULL,
                longitude DECIMAL(11, 8) NOT NULL,
                radius DECIMAL(10, 2) NOT NULL, -- in meters
                unit VARCHAR(10) DEFAULT 'meters', -- 'meters' or 'kilometers'
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Geofencing table created successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Error creating geofencing table:", err);
        process.exit(1);
    }
}

createGeofencingTable();
