const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function killStuck() {
  try {
    console.log('1. Finding stuck sessions...');
    const res = await pool.query(`
      SELECT pid, state, query
      FROM pg_stat_activity 
      WHERE datname = 'attendEase'
      AND state = 'idle in transaction'
      AND pid <> pg_backend_pid()
    `);
    
    for (const row of res.rows) {
      console.log(`Killing PID ${row.pid} (Stuck on: ${row.query.substring(0, 50)}...)`);
      await pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
    }
    
    console.log('2. Retrying supervisor_kothi creation...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS supervisor_kothi (
        assigned_id SERIAL PRIMARY KEY,
        supervisor_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
        UNIQUE (supervisor_id, ward_id)
      )
    `);
    console.log('Done 2.');

    console.log('3. Retrying user_kothi_access creation...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_kothi_access (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ward_id INTEGER NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        granted_by INTEGER,
        PRIMARY KEY (user_id, ward_id)
      )
    `);
    console.log('Done 3.');

    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_kothi_access_ward_id ON user_kothi_access (ward_id)');
    
    console.log('SUCCESS: All tables created!');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

killStuck();
