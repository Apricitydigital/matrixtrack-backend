const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('1. Starting transaction...');
    await client.query('BEGIN');
    
    console.log('2. Creating supervisor_kothi...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS supervisor_kothi (
        assigned_id SERIAL PRIMARY KEY,
        supervisor_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
        UNIQUE (supervisor_id, ward_id)
      )
    `);
    
    console.log('3. Creating user_kothi_access...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_kothi_access (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        granted_by INTEGER,
        PRIMARY KEY (user_id, ward_id)
      )
    `);

    console.log('4. Creating index...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_kothi_access_ward_id
      ON user_kothi_access (ward_id)
    `);

    await client.query('COMMIT');
    console.log('SUCCESS: All steps complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERROR during setup:', err.message);
    if (err.detail) console.error('DETAIL:', err.detail);
    if (err.hint) console.error('HINT:', err.hint);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
