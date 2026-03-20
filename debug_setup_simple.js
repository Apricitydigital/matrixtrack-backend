const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000
});

async function run() {
  try {
    console.log('1. Creating supervisor_kothi...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS supervisor_kothi (
        assigned_id SERIAL PRIMARY KEY,
        supervisor_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
        UNIQUE (supervisor_id, ward_id)
      )
    `);
    console.log('Done 1.');

    console.log('2. Creating user_kothi_access...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_kothi_access (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        granted_by INTEGER,
        PRIMARY KEY (user_id, ward_id)
      )
    `);
    console.log('Done 2.');

    console.log('3. Creating index...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_kothi_access_ward_id
      ON user_kothi_access (ward_id)
    `);
    console.log('Done 3.');

    console.log('SUCCESS!');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

run();
