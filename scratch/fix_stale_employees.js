// Fix: Deactivate old/stale professional_employees records 
// where a newer approved record exists for the same mobile.
// This ensures the sendOtp query always finds the correct active account.

const pool = require('../config/db');

async function fixStaleRecords() {
  try {
    // Find all mobiles that have multiple records
    const dupRes = await pool.query(`
      SELECT mobile, COUNT(*) as count
      FROM professional_employees
      GROUP BY mobile
      HAVING COUNT(*) > 1
    `);
    
    console.log('Mobiles with multiple records:', dupRes.rows);

    for (const row of dupRes.rows) {
      const mobile = row.mobile;
      
      // Get all records for this mobile, newest first
      const records = await pool.query(`
        SELECT id, full_name, is_active, created_at
        FROM professional_employees
        WHERE mobile = $1
        ORDER BY is_active DESC, created_at DESC
      `, [mobile]);
      
      console.log(`\nMobile ${mobile} records:`, records.rows);
      
      // Keep the first (active/newest) one, deactivate the rest
      const keepId = records.rows[0].id;
      const deactivateIds = records.rows.slice(1).map(r => r.id);
      
      if (deactivateIds.length > 0) {
        await pool.query(`
          UPDATE professional_employees
          SET is_active = false
          WHERE id = ANY($1::uuid[])
        `, [deactivateIds]);
        console.log(`Deactivated ${deactivateIds.length} old records for mobile ${mobile}, keeping ${keepId}`);
      }
    }
    
    console.log('\nFix complete!');
    
    // Show final state
    const final = await pool.query(`
      SELECT id, full_name, mobile, is_active, created_at
      FROM professional_employees
      ORDER BY created_at DESC
    `);
    console.log('\nFinal state:', JSON.stringify(final.rows, null, 2));
    
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
}

fixStaleRecords();
