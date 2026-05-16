/**
 * Dry-run syntax checker for a migration file.
 * Wraps the SQL in a transaction + savepoint, then rolls back entirely.
 * Usage: node scratch/dry_run_migration.js <migration_file.sql>
 */
require('dotenv').config();
const pool = require('../config/db');
const fs   = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scratch/dry_run_migration.js <path/to/migration.sql>');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

// Strip out BEGIN/COMMIT from the migration itself so we can wrap it in our own transaction.
const stripped = sql
  .replace(/^\s*BEGIN\s*;\s*/gim, '')
  .replace(/^\s*COMMIT\s*;\s*/gim, '');

async function dryRun() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SAVEPOINT dryrun');
    await client.query(stripped);
    await client.query('ROLLBACK TO SAVEPOINT dryrun');
    await client.query('ROLLBACK');
    console.log(`✅  DRY RUN OK — "${path.basename(file)}" has no syntax errors.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`❌  DRY RUN FAILED — ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

dryRun();
