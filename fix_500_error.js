/**
 * fix_500_error.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Ye script un database indexes ko add karta hai jo "statement timeout" wali
 * 500 error ki wajah the. Run karo ek baar aur server restart karo.
 *
 * Run: node fix_500_error.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const pool = require('./config/db');

const indexes = [
  {
    name: 'idx_attendance_date_emp',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attendance_date_emp
          ON attendance (date, emp_id)`,
    desc: 'attendance → date range lookup (main culprit of timeout)',
  },
  {
    name: 'idx_employee_ward_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_employee_ward_id
          ON employee (ward_id)`,
    desc: 'employee → ward JOIN fast karta hai',
  },
  {
    name: 'idx_supervisor_ward_ward_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supervisor_ward_ward_id
          ON supervisor_ward (ward_id)`,
    desc: 'supervisor_ward → LATERAL subquery fast karta hai',
  },
  {
    name: 'idx_supervisor_ward_supervisor_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supervisor_ward_supervisor_id
          ON supervisor_ward (supervisor_id)`,
    desc: 'supervisor_ward → supervisor filter fast karta hai',
  },
  {
    name: 'idx_supervisor_kothi_ward_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supervisor_kothi_ward_id
          ON supervisor_kothi (ward_id)`,
    desc: 'supervisor_kothi → LATERAL subquery fast karta hai',
  },
  {
    name: 'idx_supervisor_kothi_supervisor_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supervisor_kothi_supervisor_id
          ON supervisor_kothi (supervisor_id)`,
    desc: 'supervisor_kothi → supervisor filter fast karta hai',
  },
  {
    name: 'idx_user_kothi_access_user_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_kothi_access_user_id
          ON user_kothi_access (user_id)`,
    desc: 'user_kothi_access → user filter fast karta hai',
  },
  {
    name: 'idx_user_zone_access_user_id',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_zone_access_user_id
          ON user_zone_access (user_id)`,
    desc: 'user_zone_access → user filter fast karta hai',
  },
  {
    name: 'idx_attendance_emp_punch_in',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attendance_emp_punch_in
          ON attendance (emp_id, punch_in_time)
          WHERE punch_in_time IS NOT NULL`,
    desc: 'attendance → punch_in aggregate fast karta hai',
  },
];

async function run() {
  console.log('\n🔧 Database Index Fix - 500 Error Solution\n');
  console.log('='.repeat(50));

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const idx of indexes) {
    process.stdout.write(`\n📌 ${idx.name}\n   ${idx.desc}\n   Status: `);
    try {
      await pool.query(idx.sql);
      console.log('✅ Created / Already exists');
      successCount++;
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('⏭️  Skipped (already exists)');
        skipCount++;
      } else {
        console.log(`❌ Failed: ${err.message}`);
        failCount++;
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results:`);
  console.log(`   ✅ Created : ${successCount}`);
  console.log(`   ⏭️  Skipped : ${skipCount}`);
  console.log(`   ❌ Failed  : ${failCount}`);

  if (failCount === 0) {
    console.log('\n🎉 Sab indexes successfully add ho gaye!');
    console.log('👉 Ab server restart karo:\n');
    console.log('   pkill -f "node app.js" ; node app.js\n');
    console.log('   Ya agar PM2 use karte ho:\n');
    console.log('   pm2 restart all\n');
  } else {
    console.log('\n⚠️  Kuch indexes fail hue. Upar errors dekho.\n');
  }

  await pool.end();
}

run().catch((err) => {
  console.error('Script run failed:', err.message);
  pool.end();
  process.exit(1);
});
