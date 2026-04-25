const pool = require("../config/db");

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Starting migration: Create supervisor_employee_assignment table...");
    
    await client.query("BEGIN");

    // 1. Create the assignment table
    await client.query(`
      CREATE TABLE IF NOT EXISTS supervisor_employee_assignment (
        assignment_id SERIAL PRIMARY KEY,
        supervisor_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        employee_id INTEGER NOT NULL REFERENCES employee(emp_id) ON DELETE CASCADE,
        assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        UNIQUE (supervisor_id, employee_id)
      );
    `);

    // 2. Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sea_supervisor_id ON supervisor_employee_assignment(supervisor_id);
      CREATE INDEX IF NOT EXISTS idx_sea_employee_id ON supervisor_employee_assignment(employee_id);
    `);

    await client.query("COMMIT");
    console.log("Migration successful: supervisor_employee_assignment table created.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
