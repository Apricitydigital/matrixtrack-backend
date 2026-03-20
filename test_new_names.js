const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function test() {
  try {
    console.log('1. Checking for idle in transaction...');
    const res = await pool.query(`
      SELECT pid, state, query, backend_start, state_change
      FROM pg_stat_activity 
      WHERE datname = 'attendEase'
      AND state = 'idle in transaction'
    `);
    console.log('Idle in transaction:', res.rows.length);
    res.rows.forEach(row => console.log(JSON.stringify(row)));

    console.log('2. Trying a NEW table name: kothi_assignments...');
    await pool.query('CREATE TABLE IF NOT EXISTS kothi_assignments (id int);');
    console.log('Done 2.');

    console.log('3. Trying a NEW table name: user_kothi_permissions...');
    await pool.query('CREATE TABLE IF NOT EXISTS user_kothi_permissions (id int);');
    console.log('Done 3.');

    console.log('SUCCESS!');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

test();
