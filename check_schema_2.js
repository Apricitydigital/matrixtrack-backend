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
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_name IN ('user_kothi_access', 'supervisor_kothi')
    `);
    console.log('Tables found:');
    res.rows.forEach(row => console.log(`${row.table_schema}.${row.table_name}`));
    
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
