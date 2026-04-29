/**
 * ⏰ AUTO PUNCH-OUT SCHEDULER
 * ----------------------------
 * Runs every hour (e.g. at XX:00) and processes for 10 minutes.
 * Automatically punches out employees who:
 *   - Have punched IN today
 *   - Have NOT punched OUT
 *   - Have been punched in for >= 9 hours
 *
 * Marks these records with: auto_punched_out = true
 */

const pool = require("../config/db");

// IST-aware current date string (YYYY-MM-DD)
const getTodayIST = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// IST-aware current timestamp
const getNowIST = () =>
  new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

/**
 * Core function: finds all attendance records where:
 *  - today's date
 *  - punch_in_time IS NOT NULL
 *  - punch_out_time IS NULL
 *  - punch_in_time was >= AUTO_PUNCHOUT_HOURS hours ago
 * Then sets punch_out_time = NOW() and marks auto_punched_out = true
 */
const AUTO_PUNCHOUT_HOURS = parseInt(process.env.AUTO_PUNCHOUT_HOURS || "9", 10);

async function runAutoPunchOut() {
  const today = getTodayIST();
  const nowIST = getNowIST();

  console.log(`[AutoPunchOut] 🕐 Running at ${nowIST.toISOString()} | Cutoff: ${AUTO_PUNCHOUT_HOURS}h | Date: ${today}`);

  let client;
  try {
    client = await pool.connect();

    // Find eligible records: punched in but not out, >= AUTO_PUNCHOUT_HOURS hours ago
    const eligibleResult = await client.query(
      `SELECT
        a.attendance_id,
        a.emp_id,
        a.punch_in_time,
        a.ward_id,
        e.name AS emp_name,
        e.emp_code
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      WHERE a.date::date = $1::date
        AND a.punch_in_time IS NOT NULL
        AND a.punch_out_time IS NULL
        AND (NOW() AT TIME ZONE 'Asia/Kolkata') - (a.punch_in_time AT TIME ZONE 'Asia/Kolkata') >= INTERVAL '${AUTO_PUNCHOUT_HOURS} hours'`,
      [today]
    );

    const eligible = eligibleResult.rows;

    if (eligible.length === 0) {
      console.log(`[AutoPunchOut] ✅ No employees need auto punch-out.`);
      return { processed: 0 };
    }

    console.log(`[AutoPunchOut] 📋 Found ${eligible.length} employee(s) to auto punch-out.`);

    let successCount = 0;
    let failCount = 0;

    for (const record of eligible) {
      try {
        // Calculate duration from punch_in to now
        const durationResult = await client.query(
          `SELECT
            TO_CHAR(
              (NOW() AT TIME ZONE 'Asia/Kolkata') - (punch_in_time AT TIME ZONE 'Asia/Kolkata'),
              'HH24:MI:SS'
            ) AS duration
          FROM attendance
          WHERE attendance_id = $1`,
          [record.attendance_id]
        );

        const duration = durationResult.rows[0]?.duration || null;

        // Update: set punch_out_time, duration, auto_punched_out flag
        await client.query(
          `UPDATE attendance
          SET
            punch_out_time = NOW() AT TIME ZONE 'Asia/Kolkata',
            duration = $1,
            auto_punched_out = true,
            out_address = 'Auto Punch-Out (System)',
            updated_at = NOW()
          WHERE attendance_id = $2`,
          [duration, record.attendance_id]
        );

        console.log(
          `[AutoPunchOut] ✅ Punched out: ${record.emp_name} (${record.emp_code}) | attendance_id: ${record.attendance_id} | duration: ${duration}`
        );
        successCount++;
      } catch (rowErr) {
        console.error(
          `[AutoPunchOut] ❌ Failed for attendance_id ${record.attendance_id}:`,
          rowErr.message
        );
        failCount++;
      }
    }

    console.log(
      `[AutoPunchOut] 🏁 Done | Success: ${successCount} | Failed: ${failCount}`
    );
    return { processed: successCount, failed: failCount };
  } catch (err) {
    console.error("[AutoPunchOut] 💥 Scheduler error:", err.message);
    return { processed: 0, error: err.message };
  } finally {
    if (client) client.release();
  }
}

module.exports = { runAutoPunchOut };
