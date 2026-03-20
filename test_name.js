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
    console.log('1. Trying to create supervisor_kothi simple...');
    await pool.query('CREATE TABLE IF NOT EXISTS supervisor_kothi (id int);');
    console.log('Done 1.');

    console.log('2. Trying to drop it...');
    await pool.query('DROP TABLE IF EXISTS supervisor_kothi;');
    console.log('Done 2.');

    console.log('SUCCESS!');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

test();
