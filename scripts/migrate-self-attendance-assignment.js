const fs = require('node:fs');
const path = require('node:path');
const files = [
  ...(process.argv.includes('--attendance-only') ? [] : ['20261029_self_attendance_assignment_references.sql']),
  '20261030_self_attendance_records_references.sql',
];

if (!process.argv.includes('--apply')) {
  console.log(`No database changes made. Review ${files.join(', ')}, then run this script with --apply.`);
} else {
  const pool = require('../config/db');
  (async () => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('self-attendance-assignment-references'))");
      for (const file of files) {
        await client.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
      }
      await client.query('COMMIT');
      console.log('SelfAttendance assignment and attendance references repaired. Existing employee assignments and attendance history were preserved.');
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      console.error('SelfAttendance assignment repair failed:', error.message);
      process.exitCode = 1;
    } finally {
      client?.release();
      await pool.end();
    }
  })();
}
