const fs = require('node:fs');
const path = require('node:path');
const file = '20261029_professional_assignment_references.sql';

if (!process.argv.includes('--apply')) {
  console.log(`No database changes made. Review ${file}, then run this script with --apply.`);
} else {
  const pool = require('../config/db');
  (async () => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
      await client.query('COMMIT');
      console.log('Professional assignment references repaired. Existing employee assignments were preserved.');
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      console.error('Professional assignment repair failed:', error.message);
      process.exitCode = 1;
    } finally {
      client?.release();
      await pool.end();
    }
  })();
}
