const pool = require("./config/db");

async function createGeofencingRequestsTable() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS geofencing_requests (
                id SERIAL PRIMARY KEY,
                emp_id INTEGER REFERENCES employee(emp_id) ON DELETE CASCADE,
                zone_id INTEGER REFERENCES zones(zone_id) ON DELETE SET NULL,
                ward_id INTEGER REFERENCES wards(ward_id) ON DELETE SET NULL,
                supervisor_name VARCHAR(255),
                phone_number VARCHAR(20),
                latitude DECIMAL(10, 8),
                longitude DECIMAL(11, 8),
                photo_url TEXT,
                message TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW(),
                reviewed_at TIMESTAMP,
                reviewed_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL
            );
        `);
        console.log("✅ geofencing_requests table created/verified successfully.");
    } catch (error) {
        console.error("❌ Error creating geofencing_requests table:", error);
    } finally {
        client.release();
        pool.end();
    }
}

createGeofencingRequestsTable();
