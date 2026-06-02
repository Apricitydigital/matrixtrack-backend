/**
 * ============================================================
 *  WAL Auto-Cleanup Script — MatrixTrack Production
 * ============================================================
 *
 *  MANUAL CHECK (kabhi bhi):
 *    node wal_cleanup_cron.js
 *
 *  SERVER PE CRON (11 PM daily) — SSH se ek baar lagao:
 *    crontab -e
 *    0 23 * * * cd /home/ubuntu/attendease-backend && node wal_cleanup_cron.js >> /home/ubuntu/wal_cleanup.log 2>&1
 *
 *  KYA KARTA HAI:
 *    1. WAL size check karta hai
 *    2. Inactive replication slots dhundta hai
 *    3. Agar WAL > 20GB — inactive slots delete karta hai
 *    4. CHECKPOINT x3 chalata hai (WAL physically clean ho jata hai)
 *    5. Pura report print karta hai
 * ============================================================
 */

require('dotenv').config();
const pool = require('./config/db');

// ─── CONFIG ───────────────────────────────────────────────
const WAL_CLEANUP_THRESHOLD_GB = 20; // Cleanup if WAL > 20 GB
// ──────────────────────────────────────────────────────────

const IST = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
const GB = (bytes) => (bytes / (1024 ** 3)).toFixed(2);
const line = (char = '─', len = 60) => char.repeat(len);

async function walCleanup() {
  const client = await pool.connect();
  let actionsTaken = [];
  let walBefore = 0;
  let walAfter = 0;

  try {
    console.log('');
    console.log('╔' + line('═') + '╗');
    console.log('║   WAL Auto-Cleanup — MatrixTrack Production' + ' '.repeat(15) + '║');
    console.log('║   ' + IST() + ' '.repeat(60 - IST().length - 3) + '║');
    console.log('╚' + line('═') + '╝');
    console.log('');

    // ── STEP 1: WAL Size Check ────────────────────────────
    console.log('📏 STEP 1: WAL Size Check');
    console.log(line());
    const walResult = await client.query(`
      SELECT pg_size_pretty(sum(size)) AS pretty, sum(size) AS raw
      FROM pg_ls_waldir()
    `).catch(() => ({ rows: [{ pretty: 'N/A', raw: 0 }] }));

    walBefore = walResult.rows[0].raw;
    const walGB = GB(walBefore);
    const walPretty = walResult.rows[0].pretty;
    const needsCleanup = parseFloat(walGB) > WAL_CLEANUP_THRESHOLD_GB;

    console.log(`  Current WAL Size : ${walPretty} (${walGB} GB)`);
    console.log(`  Threshold        : ${WAL_CLEANUP_THRESHOLD_GB} GB`);
    console.log(`  Needs Cleanup    : ${needsCleanup ? '⚠️  YES' : '✅ NO'}`);

    // ── STEP 2: Replication Slot Scan ────────────────────
    console.log('');
    console.log('🔍 STEP 2: Replication Slot Scan');
    console.log(line());
    const slots = await client.query(`
      SELECT 
        slot_name, slot_type, active,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS wal_held,
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS raw_bytes
      FROM pg_replication_slots
      ORDER BY raw_bytes DESC NULLS LAST
    `);

    const inactiveSlots = slots.rows.filter(s => !s.active);
    const activeSlots   = slots.rows.filter(s => s.active);

    if (slots.rows.length === 0) {
      console.log('  ✅ No replication slots found — all clean!');
    } else {
      activeSlots.forEach(s => {
        console.log(`  🟢 ACTIVE   : ${s.slot_name}`);
        console.log(`               Type: ${s.slot_type} | WAL held: ${s.wal_held}`);
        console.log('               ℹ️  Active slot — NOT touching (DMS use kar raha hai)');
      });
      inactiveSlots.forEach(s => {
        console.log(`  🔴 INACTIVE : ${s.slot_name}`);
        console.log(`               Type: ${s.slot_type} | WAL held: ${s.wal_held}`);
        if (needsCleanup) {
          console.log('               ⚠️  Will be DELETED (inactive + WAL > threshold)');
        } else {
          console.log('               ℹ️  Inactive but WAL under threshold — monitoring only');
        }
      });
    }

    // ── STEP 3: Auto-Cleanup (if needed) ─────────────────
    console.log('');
    console.log('🗑️  STEP 3: Auto-Cleanup');
    console.log(line());

    if (!needsCleanup) {
      console.log(`  ✅ WAL (${walGB} GB) is under ${WAL_CLEANUP_THRESHOLD_GB} GB threshold.`);
      console.log('  No cleanup needed today.');
    } else if (inactiveSlots.length === 0) {
      console.log('  ⚠️  WAL is large but NO inactive slots found.');
      console.log('  Active DMS slots are present — cannot delete them.');
      console.log('  Running CHECKPOINT to reclaim what we can...');
      await client.query('CHECKPOINT');
      await client.query('CHECKPOINT');
      await client.query('CHECKPOINT');
      actionsTaken.push('CHECKPOINT x3 (no inactive slots to delete)');
    } else {
      // Delete all INACTIVE slots only
      for (const slot of inactiveSlots) {
        try {
          await client.query(`SELECT pg_drop_replication_slot($1)`, [slot.slot_name]);
          console.log(`  ✅ Deleted slot: ${slot.slot_name} (was holding ${slot.wal_held})`);
          actionsTaken.push(`Deleted slot: ${slot.slot_name} (${slot.wal_held})`);
        } catch (err) {
          console.log(`  ❌ Could not delete ${slot.slot_name}: ${err.message}`);
        }
      }

      // Run 3 CHECKPOINTs to flush WAL
      console.log('');
      console.log('  🔄 Running CHECKPOINT x3 to flush WAL...');
      await client.query('CHECKPOINT');
      console.log('     CHECKPOINT 1 ✅');
      await client.query('CHECKPOINT');
      console.log('     CHECKPOINT 2 ✅');
      await client.query('CHECKPOINT');
      console.log('     CHECKPOINT 3 ✅');
      actionsTaken.push('CHECKPOINT x3');
    }

    // ── STEP 4: VACUUM attendance (dead rows cleanup) ─────
    console.log('');
    console.log('🧹 STEP 4: Attendance Table VACUUM');
    console.log(line());
    const deadRows = await client.query(`
      SELECT n_dead_tup, n_live_tup,
        ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct
      FROM pg_stat_user_tables
      WHERE relname = 'attendance'
    `);
    const d = deadRows.rows[0];
    console.log(`  Dead rows   : ${Number(d.n_dead_tup).toLocaleString()} (${d.dead_pct}%)`);
    if (parseFloat(d.dead_pct) > 10) {
      console.log('  Running VACUUM ANALYZE...');
      await client.query('VACUUM ANALYZE attendance');
      console.log('  ✅ VACUUM complete!');
      actionsTaken.push('VACUUM ANALYZE attendance');
    } else {
      console.log('  ✅ Dead rows OK — no VACUUM needed.');
    }

    // ── STEP 5: WAL Size After ────────────────────────────
    console.log('');
    console.log('📊 STEP 5: Final Status');
    console.log(line());
    const walAfterResult = await client.query(`
      SELECT pg_size_pretty(sum(size)) AS pretty, sum(size) AS raw FROM pg_ls_waldir()
    `).catch(() => ({ rows: [{ pretty: 'N/A', raw: walBefore }] }));
    walAfter = walAfterResult.rows[0].raw;

    const freed = walBefore - walAfter;
    const freedGB = GB(freed);

    const attCount = await client.query(`SELECT COUNT(*) AS c FROM attendance`);
    const empCount = await client.query(`SELECT COUNT(*) AS c FROM employee`);
    const dbSize   = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s`);
    const slotsNow = await client.query(`SELECT COUNT(*) AS c FROM pg_replication_slots`);

    console.log(`  WAL Before       : ${GB(walBefore)} GB`);
    console.log(`  WAL After        : ${GB(walAfter)} GB`);
    console.log(`  Space Freed      : ${freed > 0 ? freedGB + ' GB ✅' : '0 GB (AWS will reclaim shortly)'}`);
    console.log('');
    console.log(`  DB Size          : ${dbSize.rows[0].s}`);
    console.log(`  Attendance Rows  : ${Number(attCount.rows[0].c).toLocaleString()} ✅`);
    console.log(`  Employee Rows    : ${Number(empCount.rows[0].c).toLocaleString()} ✅`);
    console.log(`  Replication Slots: ${slotsNow.rows[0].c}`);

    // ── SUMMARY ───────────────────────────────────────────
    console.log('');
    console.log('╔' + line('═') + '╗');
    console.log('║   SUMMARY' + ' '.repeat(50) + '║');
    console.log('╠' + line('═') + '╣');
    if (actionsTaken.length === 0) {
      console.log('║   ✅ Nothing to do — everything was healthy!   ' + ' '.repeat(11) + '║');
    } else {
      actionsTaken.forEach(a => {
        const msg = `║   ✅ ${a}`;
        console.log(msg + ' '.repeat(Math.max(0, 61 - msg.length)) + '║');
      });
    }
    console.log('╚' + line('═') + '╝');
    console.log('');

  } catch (err) {
    console.error('❌ WAL Cleanup Error:', err.message);
  } finally {
    client.release();
  }
}

walCleanup();
