const pool = require('./config/db');

async function runMigration() {
  console.log("Starting Safe Database Migration for Supervisor Registration...");

  const client = await pool.connect();
  try {
    // Start Transaction for safety
    await client.query('BEGIN');
    console.log("Transaction started...");

    // 1. Add missing columns to 'users' table (IF NOT EXISTS prevents errors if already present)
    console.log("Updating 'users' table schema...");
    const alterUsersQueries = [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS emp_code VARCHAR(255);`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(255);`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhar_number VARCHAR(255);`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhar_doc_url TEXT;`
    ];

    for (const query of alterUsersQueries) {
      await client.query(query);
      console.log(`Executed: ${query.split('ADD COLUMN IF NOT EXISTS ')[1]}`);
    }

    // 2. Create 'supervisor_ward' table (IF NOT EXISTS prevents overwrite/errors)
    console.log("Ensuring 'supervisor_ward' table exists for location assignment...");
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS supervisor_ward (
        id SERIAL PRIMARY KEY,
        supervisor_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER REFERENCES wards(ward_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supervisor_id, ward_id)
      );
    `;
    await client.query(createTableQuery);
    console.log("Checked/Created 'supervisor_ward' table successfully.");

    // Commit Transaction
    await client.query('COMMIT');
    console.log("==========================================");
    console.log("✅ MIGRATION SUCCESSFUL! Database schema is now fully updated.");
    console.log("✅ Existing data is 100% safe and unaffected.");
    console.log("==========================================");

  } catch (error) {
    // Rollback if any error occurs to ensure zero damage
    await client.query('ROLLBACK');
    console.error("❌ MIGRATION FAILED. Changes rolled back.", error);
  } finally {
    client.release();
    pool.end();
  }
}

runMigration();
