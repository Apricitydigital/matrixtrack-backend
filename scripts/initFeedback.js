const pool = require("../config/db");

const createFeedbackTables = async () => {
    try {
        console.log("Creating feedback tables...");
        
        // 1. Feedback Config (Admin decides the question)
        const configQuery = `
        CREATE TABLE IF NOT EXISTS feedback_config (
            id SERIAL PRIMARY KEY,
            question TEXT NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        `;
        await pool.query(configQuery);

        // 2. Feedback Responses (Stored users' reviews)
        const responseQuery = `
        CREATE TABLE IF NOT EXISTS feedback_responses (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
            comment TEXT,
            config_id INTEGER REFERENCES feedback_config(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        `;
        await pool.query(responseQuery);

        // 3. Seed initial question if empty
        const seedQuery = `
        INSERT INTO feedback_config (question, is_active)
        SELECT 'How is your experience with the MatrixTrack app today?', TRUE
        WHERE NOT EXISTS (SELECT 1 FROM feedback_config);
        `;
        await pool.query(seedQuery);

        console.log("Feedback tables and seeding complete.");
    } catch (err) {
        console.error("Error creating feedback tables:", err);
    } finally {
        await pool.end();
    }
};

createFeedbackTables();
