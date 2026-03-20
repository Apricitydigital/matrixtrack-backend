const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function checkSessions() {
  try {
    const res = await pool.query(`
      SELECT pid, state, query, wait_event_type, wait_event 
      FROM pg_stat_activity 
      WHERE datname = 'attendEase'
      AND pid <> pg_backend_pid()
    `);
    console.log('Active sessions:');
    res.rows.forEach(row => console.log(JSON.stringify(row)));
    
    if (res.rows.length === 0) console.log('No active sessions found.');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

checkSessions();
