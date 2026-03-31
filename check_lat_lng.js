const pool = require('./config/db');

async function check() {
  try {
    // 1. Check columns exist
    const cols = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'attendance'
      ORDER BY ordinal_position
    `);
    console.log('\n=== attendance table columns ===');
    cols.rows.forEach(r => console.log(`${r.column_name} (${r.data_type})`));

    // 2. Check a few rows with in_address filled
    const rows = await pool.query(`
      SELECT attendance_id, in_address, latitude_in, longitude_in, out_address, latitude_out, longitude_out
      FROM attendance
      WHERE in_address IS NOT NULL AND in_address != ''
      LIMIT 5
    `);
    console.log('\n=== Sample rows with in_address ===');
    rows.rows.forEach(r => console.log(r));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

check();
