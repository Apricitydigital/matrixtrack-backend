const { Pool } = require('pg');
const pool = new Pool({
  user: 'postgres',
  password: 'postgresql',
  host: 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
  database: 'attendEase',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('Renaming sector_id to ward_id in user_kothi_access...');
    await client.query(`
      ALTER TABLE user_kothi_access 
      RENAME COLUMN sector_id TO ward_id
    `);

    console.log('Renaming sector_id to ward_id in supervisor_kothi...');
    await client.query(`
      ALTER TABLE supervisor_kothi 
      RENAME COLUMN sector_id TO ward_id
    `);
    
    // Also update constraints/indexes if necessary, though RENAME often handles them.
    // Let's explicitly check and rename the index for consistency.
    console.log('Renaming index idx_user_kothi_access_sector_id...');
    await client.query(`
      ALTER INDEX IF EXISTS idx_user_kothi_access_sector_id 
      RENAME TO idx_user_kothi_access_ward_id
    `);

    await client.query('COMMIT');
    console.log('Migration successful!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
