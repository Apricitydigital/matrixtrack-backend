/**
 * ⏰ AUTO PUNCH-OUT SCHEDULER
 * ----------------------------
 * Runs once daily at 9:00 PM IST.
 * Automatically punches out employees who:
 *   - Have punched IN today
 *   - Have NOT punched OUT
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

const AUTO_PUNCHOUT_HOURS = parseInt(process.env.AUTO_PUNCHOUT_HOURS || "9", 10);
let professionalColumnsEnsured = false;

async function ensureProfessionalAutoPunchColumns(client) {
  if (professionalColumnsEnsured) return;
  await client.query(`
    ALTER TABLE professional_attendance
      ADD COLUMN IF NOT EXISTS auto_punched_out BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS out_address TEXT
  `);
  professionalColumnsEnsured = true;
}

async function runAutoPunchOut() {
  const today = getTodayIST();
  const nowIST = getNowIST();

  console.log(`[AutoPunchOut] 🕐 Running at ${nowIST.toISOString()} | Shift length: ${AUTO_PUNCHOUT_HOURS}h | Date: ${today}`);

  let client;
  try {
    client = await pool.connect();

    await ensureProfessionalAutoPunchColumns(client);

    const attendanceUpdateResult = await client.query(
      `WITH updated AS (
        UPDATE attendance a
        SET
          punch_out_time = a.punch_in_time + INTERVAL '${AUTO_PUNCHOUT_HOURS} hours',
          duration = TO_CHAR(
            INTERVAL '${AUTO_PUNCHOUT_HOURS} hours',
            'HH24:MI'
          ),
          auto_punched_out = true,
          out_address = 'Auto Punch-Out (System)',
          updated_at = NOW()
        WHERE a.date::date = $1::date
          AND a.punch_in_time IS NOT NULL
          AND a.punch_out_time IS NULL
        RETURNING a.attendance_id, a.emp_id, a.duration
      )
      SELECT u.attendance_id, u.duration, e.name AS emp_name, e.emp_code
      FROM updated u
      JOIN employee e ON u.emp_id = e.emp_id`,
      [today]
    );

    const professionalUpdateResult = await client.query(
      `WITH updated AS (
        UPDATE professional_attendance pa
        SET
          punch_out = pa.punch_in + INTERVAL '${AUTO_PUNCHOUT_HOURS} hours',
          auto_punched_out = true,
          out_address = 'Auto Punch-Out (System)'
        WHERE pa.date = $1::date
          AND pa.punch_in IS NOT NULL
          AND pa.punch_out IS NULL
        RETURNING pa.id, pa.professional_id, pa.punch_in, pa.punch_out
      )
      SELECT
        u.id,
        pe.full_name,
        pe.mobile,
        TO_CHAR((u.punch_out - u.punch_in), 'HH24:MI') AS duration
      FROM updated u
      JOIN professional_employees pe ON pe.id = u.professional_id`,
      [today]
    );

    const updatedRecords = attendanceUpdateResult.rows;
    const updatedProfessionalRecords = professionalUpdateResult.rows;
    const totalUpdated = updatedRecords.length + updatedProfessionalRecords.length;

    if (totalUpdated === 0) {
      console.log(`[AutoPunchOut] ✅ No records need auto punch-out.`);
      return { processed: 0, failed: 0 };
    }

    console.log(`[AutoPunchOut] 📋 Updated attendance: ${updatedRecords.length}, professional_attendance: ${updatedProfessionalRecords.length}.`);

    for (const record of updatedRecords) {
      console.log(
        `[AutoPunchOut] ✅ Punched out: ${record.emp_name} (${record.emp_code}) | attendance_id: ${record.attendance_id} | duration: ${record.duration}`
      );
    }
    for (const record of updatedProfessionalRecords) {
      console.log(
        `[AutoPunchOut] ✅ Professional auto punched out: ${record.full_name} (${record.mobile}) | attendance_id: ${record.id} | duration: ${record.duration}`
      );
    }

    console.log(
      `[AutoPunchOut] 🏁 Done | Success: ${totalUpdated} | Failed: 0`
    );
    return { processed: totalUpdated, failed: 0 };
  } catch (err) {
    console.error("[AutoPunchOut] 💥 Scheduler error:", err.message);
    return { processed: 0, error: err.message };
  } finally {
    if (client) client.release();
  }
}

module.exports = { runAutoPunchOut };
