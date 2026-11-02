'use strict';
const fs = require('node:fs'), path = require('node:path');
const dotenv = require('dotenv');
function loadMigrationTarget(args, {environment = process.env, defaultEnvFile = path.resolve(__dirname, '../.env')} = {}) {
  const arg = name => args.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
  const explicitFile = arg('--env-file');
  const envFile = path.resolve(explicitFile || defaultEnvFile);
  if (explicitFile && !fs.existsSync(envFile)) throw Error('Requested migration environment file does not exist');
  const file = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
  // An explicit file is authoritative; otherwise deployment environment wins.
  const env = explicitFile ? file : {...file, ...environment};
  const host = env.DB_HOST, database = env.DB_NAME, port = Number(env.DB_PORT || 5432);
  if (!host || !database || !env.DB_USER || !env.DB_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Incomplete or invalid migration database configuration');
  if (!arg('--expected-host') || arg('--expected-host') !== host) throw Error('Supply --expected-host matching the intended database host');
  if (!arg('--expected-database') || arg('--expected-database') !== database) throw Error('Supply --expected-database matching the intended database name');
  if (args.includes('--apply') && !args.includes('--maintenance-confirmed')) throw Error('--apply requires --maintenance-confirmed after all attendance writers are stopped');
  return {host, database, port, user:env.DB_USER, password:env.DB_PASSWORD};
}
async function verifyConnectedTarget(client, target) {
  const row = (await client.query('SELECT current_database()::text AS database, pg_is_in_recovery() AS replica')).rows[0];
  if (!row || row.database !== target.database || row.replica) throw Error('Connected database identity or primary status does not match the migration target');
  return {host:target.host, port:target.port, database:row.database};
}
module.exports = {loadMigrationTarget, verifyConnectedTarget};
