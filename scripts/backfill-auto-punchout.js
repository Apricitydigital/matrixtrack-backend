require("dotenv").config();
const pool = require("../config/db");

async function run() {
  const hours = Number(process.env.AUTO_PUNCHOUT_HOURS ?? 9) || 9;
  const batchSize = Number(process.env.AUTO_PUNCHOUT_BACKFILL_BATCH_SIZE ?? 100) || 100;
  const maxBatches = Number(process.env.AUTO_PUNCHOUT_BACKFILL_MAX_BATCHES ?? 0) || 0;
  let totalUpdated = 0;
  let batch = 0;
  const startedAt = Date.now();
  const client = await pool.connect();

  try {
    // Backfill can touch many rows; relax timeout only for this connection.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '5s'");

    while (true) {
      batch += 1;
      if (maxBatches > 0 && batch > maxBatches) {
        console.log(`[BackfillAutoPunchOut] Reached max batch limit (${maxBatches}). Stopping safely.`);
        break;
      }
      const result = await client.query(
        `WITH target AS (
           SELECT a.attendance_id
           FROM attendance a
           WHERE a.punch_in_time IS NOT NULL
             AND a.punch_out_time IS NULL
             AND COALESCE(a.is_auto_punch_out, FALSE) = FALSE
             AND a.punch_in_time < (NOW() AT TIME ZONE 'Asia/Kolkata') - ($1 * INTERVAL '1 hour')
           ORDER BY a.attendance_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE attendance a
            SET punch_out_time    = a.punch_in_time + ($1 * INTERVAL '1 hour'),
                duration          = LPAD($1::text, 2, '0') || ':00',
                is_auto_punch_out = TRUE,
                punched_out_by    = NULL
         FROM target t
         WHERE a.attendance_id = t.attendance_id
         RETURNING a.attendance_id`,
        [hours, batchSize]
      );

      totalUpdated += result.rowCount;
      console.log(
        `[BackfillAutoPunchOut] Batch ${batch}: updated ${result.rowCount} record(s).`
      );

      if (result.rowCount < batchSize) {
        break;
      }
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[BackfillAutoPunchOut] Done. Total updated ${totalUpdated} record(s) using ${hours}h threshold in ${elapsedSec}s.`
    );
  } catch (error) {
    console.error("[BackfillAutoPunchOut] Failed:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
