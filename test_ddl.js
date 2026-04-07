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
    console.log('1. Trying to create a temp table...');
    await pool.query('CREATE TABLE IF NOT EXISTS z_test_table (id int);');
    console.log('Done 1.');

    console.log('2. Trying to drop it...');
    await pool.query('DROP TABLE IF EXISTS z_test_table;');
    console.log('Done 2.');

    console.log('3. Checking read-only settings...');
    const res = await pool.query("SHOW default_transaction_read_only;");
    console.log('Read only:', res.rows[0]);

    console.log('SUCCESS!');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await pool.end();
  }
}

test();
