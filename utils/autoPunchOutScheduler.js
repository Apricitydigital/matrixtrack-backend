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

    // Single batch update query to prevent DB slowdown
    const updateResult = await client.query(
      `WITH updated AS (
        UPDATE attendance a
        SET
          punch_out_time = NOW() AT TIME ZONE 'Asia/Kolkata',
          duration = TO_CHAR(
            ((NOW() AT TIME ZONE 'Asia/Kolkata') - a.punch_in_time),
            'HH24:MI'
          ),
          auto_punched_out = true,
          out_address = 'Auto Punch-Out (System)',
          updated_at = NOW()
        WHERE a.date::date = $1::date
          AND a.punch_in_time IS NOT NULL
          AND a.punch_out_time IS NULL
          AND ((NOW() AT TIME ZONE 'Asia/Kolkata') - a.punch_in_time) >= INTERVAL '${AUTO_PUNCHOUT_HOURS} hours'
        RETURNING a.attendance_id, a.emp_id, a.duration
      )
      SELECT u.attendance_id, u.duration, e.name AS emp_name, e.emp_code
      FROM updated u
      JOIN employee e ON u.emp_id = e.emp_id`,
      [today]
    );

    const updatedRecords = updateResult.rows;

    if (updatedRecords.length === 0) {
      console.log(`[AutoPunchOut] ✅ No employees need auto punch-out.`);
      return { processed: 0, failed: 0 };
    }

    console.log(`[AutoPunchOut] 📋 Batch updated ${updatedRecords.length} employee(s).`);

    for (const record of updatedRecords) {
      console.log(
        `[AutoPunchOut] ✅ Punched out: ${record.emp_name} (${record.emp_code}) | attendance_id: ${record.attendance_id} | duration: ${record.duration}`
      );
    }

    console.log(
      `[AutoPunchOut] 🏁 Done | Success: ${updatedRecords.length} | Failed: 0`
    );
    return { processed: updatedRecords.length, failed: 0 };
  } catch (err) {
    console.error("[AutoPunchOut] 💥 Scheduler error:", err.message);
    return { processed: 0, error: err.message };
  } finally {
    if (client) client.release();
  }
}

module.exports = { runAutoPunchOut };
