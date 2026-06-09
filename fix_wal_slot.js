/**
 * fix_wal_slot.js
 * 
 * Finds ALL inactive replication slots and deletes them.
 * Active slots (DMS in use) are NEVER touched.
 * 
 * Run manually anytime:
 *   node fix_wal_slot.js
 */

require('dotenv').config();
const pool = require('./config/db');

async function fixWAL() {
  const client = await pool.connect();
  try {
    console.log('\n========================================');
    console.log('   WAL Replication Slot Fix');
    console.log('========================================\n');

    // Get ALL slots
    const allSlots = await client.query(`
      SELECT slot_name, slot_type, active,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_held,
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS raw_bytes
      FROM pg_replication_slots
      ORDER BY raw_bytes DESC NULLS LAST
    `);

    if (allSlots.rows.length === 0) {
      console.log('✅ No replication slots found — already clean!');
      return;
    }

    const activeSlots   = allSlots.rows.filter(s => s.active);
    const inactiveSlots = allSlots.rows.filter(s => !s.active);

    // Show active slots (will NOT be deleted)
    if (activeSlots.length > 0) {
      console.log('🟢 ACTIVE slots (DMS in use — NOT deleting):');
      activeSlots.forEach(s => {
        console.log(`   ${s.slot_name} | ${s.slot_type} | WAL held: ${s.wal_held}`);
      });
      console.log('');
    }

    // Show + delete inactive slots
    if (inactiveSlots.length === 0) {
      console.log('✅ No INACTIVE slots found — nothing to delete.');
    } else {
      console.log(`🔴 INACTIVE slots found: ${inactiveSlots.length}`);
      for (const slot of inactiveSlots) {
        console.log(`\n   Slot : ${slot.slot_name}`);
        console.log(`   Type : ${slot.slot_type}`);
        console.log(`   WAL  : ${slot.wal_held}`);
        console.log('   🗑️  Deleting...');
        await client.query(`SELECT pg_drop_replication_slot($1)`, [slot.slot_name]);
        console.log('   ✅ Deleted!');
      }

      // Run CHECKPOINT to flush WAL
      console.log('\n🔄 Running CHECKPOINT x3 to reclaim WAL space...');
      await client.query('CHECKPOINT');
      console.log('   CHECKPOINT 1 ✅');
      await client.query('CHECKPOINT');
      console.log('   CHECKPOINT 2 ✅');
      await client.query('CHECKPOINT');
      console.log('   CHECKPOINT 3 ✅');
    }

    // VACUUM attendance
    console.log('\n🧹 Running VACUUM ANALYZE on attendance...');
    await client.query('VACUUM ANALYZE attendance');
    console.log('   ✅ VACUUM complete!');

    // Final status
    const walAfter = await client.query(`
      SELECT pg_size_pretty(sum(size)) AS wal_size FROM pg_ls_waldir()
    `).catch(() => ({ rows: [{ wal_size: 'N/A' }] }));

    const slotsLeft = await client.query(`SELECT COUNT(*) AS c FROM pg_replication_slots`);
    const attCount  = await client.query(`SELECT COUNT(*) AS c FROM attendance`);

    console.log('\n========================================');
    console.log('  ✅ Fix Complete!');
    console.log(`  WAL Size now   : ${walAfter.rows[0].wal_size}`);
    console.log(`  Slots left     : ${slotsLeft.rows[0].c}`);
    console.log(`  Attendance rows: ${Number(attCount.rows[0].c).toLocaleString()} ✅`);
    console.log('========================================\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

fixWAL();
