/**
 * wal_delete.js — Delete Inactive WAL Slots + CHECKPOINT
 * Active slots (DMS in use) are NEVER touched.
 *
 * Usage: node wal_delete.js
 */

require('dotenv').config();
const pool = require('./config/db');

async function walDelete() {
  const client = await pool.connect();
  try {
    console.log('\n========================================');
    console.log('   WAL Slot Delete + Cleanup');
    console.log('   ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
    console.log('========================================\n');

    // WAL size before
    const before = await client.query(`
      SELECT pg_size_pretty(sum(size)) AS wal_size,
             ROUND(sum(size) / 1024.0 / 1024.0 / 1024.0, 2) AS wal_gb
      FROM pg_ls_waldir()
    `).catch(() => ({ rows: [{ wal_size: 'N/A', wal_gb: 0 }] }));
    console.log(`📏 WAL Before : ${before.rows[0].wal_size}`);

    // Get all slots
    const slots = await client.query(`
      SELECT slot_name, slot_type, active,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_held
      FROM pg_replication_slots
    `);

    if (slots.rows.length === 0) {
      console.log('\n✅ No slots found — already clean!');
    } else {
      const activeSlots   = slots.rows.filter(s => s.active);
      const inactiveSlots = slots.rows.filter(s => !s.active);

      // Show active (not deleting)
      activeSlots.forEach(s => {
        console.log(`\n🟢 SKIPPING (active/DMS): ${s.slot_name}`);
      });

      // Delete inactive
      if (inactiveSlots.length === 0) {
        console.log('\n✅ No inactive slots to delete.');
      } else {
        for (const slot of inactiveSlots) {
          console.log(`\n🔴 Deleting: ${slot.slot_name}`);
          console.log(`   WAL held: ${slot.wal_held}`);
          await client.query(`SELECT pg_drop_replication_slot($1)`, [slot.slot_name]);
          console.log('   ✅ Deleted!');
        }

        // CHECKPOINT to flush WAL
        console.log('\n🔄 Running CHECKPOINT x3...');
        await client.query('CHECKPOINT'); console.log('   CHECKPOINT 1 ✅');
        await client.query('CHECKPOINT'); console.log('   CHECKPOINT 2 ✅');
        await client.query('CHECKPOINT'); console.log('   CHECKPOINT 3 ✅');
      }
    }

    // WAL size after
    const after = await client.query(`
      SELECT pg_size_pretty(sum(size)) AS wal_size
      FROM pg_ls_waldir()
    `).catch(() => ({ rows: [{ wal_size: 'N/A' }] }));

    const slotsLeft = await client.query(`SELECT COUNT(*) AS c FROM pg_replication_slots`);

    console.log('\n========================================');
    console.log(`  WAL Before : ${before.rows[0].wal_size}`);
    console.log(`  WAL After  : ${after.rows[0].wal_size}`);
    console.log(`  Slots Left : ${slotsLeft.rows[0].c}`);
    console.log('  ✅ Done!');
    console.log('========================================\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

walDelete();
