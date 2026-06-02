/**
 * wal_check.js — WAL Status Check (READ ONLY)
 * Kuch bhi delete nahi karta.
 *
 * Usage: node wal_check.js
 */

require('dotenv').config();
const pool = require('./config/db');

async function walCheck() {
  const client = await pool.connect();
  try {
    console.log('\n========================================');
    console.log('   WAL Status Check (Read Only)');
    console.log('   ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
    console.log('========================================\n');

    // 1. WAL Directory Size
    const wal = await client.query(`
      SELECT pg_size_pretty(sum(size)) AS wal_size, 
             ROUND(sum(size) / 1024.0 / 1024.0 / 1024.0, 2) AS wal_gb
      FROM pg_ls_waldir()
    `).catch(() => ({ rows: [{ wal_size: 'N/A', wal_gb: 0 }] }));

    const walGB = parseFloat(wal.rows[0].wal_gb);
    const walEmoji = walGB > 20 ? '🚨' : walGB > 10 ? '⚠️ ' : '✅';
    console.log(`${walEmoji} WAL Size     : ${wal.rows[0].wal_size} (${walGB} GB)`);

    if (walGB > 20) {
      console.log('   ⚠️  WAL > 20 GB — run wal_delete.js to fix!');
    }

    // 2. Replication Slots
    const slots = await client.query(`
      SELECT slot_name, slot_type, active,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_held,
        ROUND(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) / 1024.0 / 1024.0 / 1024.0, 2) AS held_gb
      FROM pg_replication_slots
      ORDER BY held_gb DESC NULLS LAST
    `);

    console.log(`\n🔍 Replication Slots : ${slots.rows.length} found`);
    if (slots.rows.length === 0) {
      console.log('   ✅ None — clean!');
    } else {
      slots.rows.forEach(s => {
        const status = s.active ? '🟢 ACTIVE  ' : '🔴 INACTIVE';
        console.log(`   ${status} | WAL held: ${s.wal_held} | ${s.slot_name}`);
        if (!s.active) {
          console.log('             ↑ Run wal_delete.js to delete this!');
        }
      });
    }

    // 3. DB Size
    const db = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
    console.log(`\n💾 DB Size           : ${db.rows[0].size}`);

    // 4. Summary
    const inactiveCount = slots.rows.filter(s => !s.active).length;
    console.log('\n========================================');
    if (inactiveCount > 0 || walGB > 20) {
      console.log(`  ⚠️  Action needed!`);
      if (inactiveCount > 0) console.log(`  → ${inactiveCount} inactive slot(s) — run: node wal_delete.js`);
      if (walGB > 20)        console.log(`  → WAL ${walGB}GB — run: node wal_delete.js`);
    } else {
      console.log('  ✅ All good! Nothing to delete.');
    }
    console.log('========================================\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

walCheck();
