const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'user_kothi_access'
    `);
    console.log('Columns in user_kothi_access:');
    res.rows.forEach(row => console.log(`${row.column_name} (${row.data_type})`));
    
    const res2 = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'supervisor_kothi'
    `);
    console.log('\nColumns in supervisor_kothi:');
    res2.rows.forEach(row => console.log(`${row.column_name} (${row.data_type})`));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
