'use strict';
const {createHash} = require('node:crypto');
let cursorSequence = 0;
const quote = value => '"' + String(value).replace(/"/g, '""') + '"';

// Caller owns a transaction. Only row hashes cross the connection, in bounded
// batches; PostgreSQL can spill the sort to disk instead of string_agg-ing an
// entire attendance history into one value. rowExpression is trusted SQL only.
async function fullRowFingerprint(client, table, {rowExpression = 'to_jsonb(t)', batchSize = 10000} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50000) throw Error('Invalid fingerprint batch size');
  const cursor = 'attendance_preservation_' + (++cursorSequence);
  const hash = createHash('sha256');
  let count = 0n, opened = false, failed = false;
  try {
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR
      SELECT md5((${rowExpression})::text) AS row_hash FROM public.${quote(table)} t ORDER BY row_hash`);
    opened = true;
    while (true) {
      const {rows} = await client.query(`FETCH FORWARD ${batchSize} FROM ${cursor}`);
      for (const row of rows) {
        if (!/^[a-f0-9]{32}$/.test(row.row_hash)) throw Error('Invalid row fingerprint returned by database');
        hash.update(row.row_hash + '\n');
        count++;
      }
      if (rows.length < batchSize) break;
    }
    return {count: count.toString(), row_sha256: hash.digest('hex')};
  } catch(error) {
    failed=true;throw error;
  } finally {
    if(opened)try{await client.query(`CLOSE ${cursor}`);}catch(error){if(!failed)throw error;}
  }
}
module.exports = {fullRowFingerprint};
