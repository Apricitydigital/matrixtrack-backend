const pool = require("../config/db");

const testConnectionAndCreate = async () => {
    try {
        console.log("Checking database connection...");
        const res = await pool.query("SELECT NOW()");
        console.log("Database connection successful:", res.rows[0].now);

        const query = `
        CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            content TEXT NOT NULL,
            target_role VARCHAR(50) DEFAULT 'supervisor', -- 'all', 'supervisor', 'admin'
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        `;
        await pool.query(query);
        console.log("Announcements table check/creation complete.");

        // Insert a dummy official message for testing
        const insertQuery = `
        INSERT INTO announcements (title, content, target_role, is_active)
        SELECT 'Official Government Notice', 'Attendance tracking is mandatory for all personnel. Please ensure your location is enabled.', 'supervisor', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE title = 'Official Government Notice');
        `;
        await pool.query(insertQuery);
        console.log("Test announcement ensured.");

    } catch (err) {
        console.error("Database operation failed:", err);
    } finally {
        await pool.end();
    }
};

testConnectionAndCreate();
