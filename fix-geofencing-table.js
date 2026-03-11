const pool = require("./config/db");

async function fixGeofencingRequestsTable() {
    const client = await pool.connect();
    try {
        console.log("Starting column verification for geofencing_requests table...");

        const columnsToAdd = [
            { name: "emp_id", type: "INTEGER REFERENCES employee(emp_id) ON DELETE CASCADE" },
            { name: "phone_number", type: "VARCHAR(20)" },
            { name: "latitude", type: "DECIMAL(10, 8)" },
            { name: "longitude", type: "DECIMAL(11, 8)" },
            { name: "photo_url", type: "TEXT" },
            { name: "message", type: "TEXT" },
            { name: "reviewed_at", type: "TIMESTAMP" },
            { name: "reviewed_by", type: "INTEGER" }
        ];

        for (const col of columnsToAdd) {
            const res = await client.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'geofencing_requests' AND column_name = $1
            `, [col.name]);

            if (res.rows.length === 0) {
                console.log(`Adding missing column: ${col.name}...`);
                await client.query(`ALTER TABLE geofencing_requests ADD COLUMN ${col.name} ${col.type}`);
                console.log(`✅ ${col.name} added.`);
            } else {
                console.log(`✅ ${col.name} already exists.`);
            }
        }

        console.log("Verification complete.");
    } catch (error) {
        console.error("❌ Error during table fix:", error);
    } finally {
        client.release();
        process.exit();
    }
}

fixGeofencingRequestsTable();
