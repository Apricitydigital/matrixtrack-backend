const pool = require("./config/db");

async function migrateGeofencingRequests() {
    const client = await pool.connect();
    try {
        console.log("Checking if emp_id column exists in geofencing_requests table...");
        const res = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'geofencing_requests' AND column_name = 'emp_id'
        `);

        if (res.rows.length === 0) {
            console.log("Adding emp_id column to geofencing_requests table...");
            await client.query(`
                ALTER TABLE geofencing_requests 
                ADD COLUMN emp_id INTEGER REFERENCES employee(emp_id) ON DELETE CASCADE
            `);
            console.log("✅ emp_id column added successfully.");
        } else {
            console.log("✅ emp_id column already exists.");
        }
    } catch (error) {
        console.error("❌ Error migrating geofencing_requests table:", error);
    } finally {
        client.release();
        process.exit();
    }
}

migrateGeofencingRequests();
