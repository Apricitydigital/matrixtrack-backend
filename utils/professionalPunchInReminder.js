const pool = require("../config/db");
const { ensureProfessionalLeaveSchema } = require("./professionalLeaveSchema");

const runProfessionalPunchInReminder = async () => {
  const client = await pool.connect();
  try {
    await ensureProfessionalLeaveSchema();

    const insertQuery = `
      WITH ist_today AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS day
      )
      INSERT INTO professional_notifications (
        professional_id,
        type,
        title,
        message,
        metadata
      )
      SELECT
        pe.id,
        'punch-in-reminder',
        'Attendance Reminder',
        CONCAT(
          'Hi ',
          COALESCE(NULLIF(TRIM(pe.full_name), ''), 'Professional'),
          ', we noticed today''s punch-in is still pending. Please mark your attendance when you''re ready. Have a great day!'
        ),
        jsonb_build_object(
          'reminder_date', ist_today.day::text,
          'category', 'attendance',
          'kind', 'missing-punch-in'
        )
      FROM professional_employees pe
      CROSS JOIN ist_today
      WHERE pe.is_active = true
        AND NOT EXISTS (
          SELECT 1
          FROM professional_attendance pa
          WHERE pa.professional_id = pe.id
            AND pa.date = ist_today.day
        )
        AND NOT EXISTS (
          SELECT 1
          FROM professional_leave_requests plr
          WHERE plr.professional_id = pe.id
            AND plr.requested_date = ist_today.day
            AND plr.status = 'approved'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM professional_notifications pn
          WHERE pn.professional_id = pe.id
            AND pn.type = 'punch-in-reminder'
            AND COALESCE(pn.metadata ->> 'reminder_date', '') = ist_today.day::text
        )
      RETURNING professional_id
    `;

    const result = await client.query(insertQuery);
    const sentCount = result.rowCount || 0;
    console.log(`[ProfessionalReminderCron] Sent punch-in reminders: ${sentCount}`);
    return { sentCount };
  } catch (error) {
    console.error("[ProfessionalReminderCron] Failed:", error.message);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { runProfessionalPunchInReminder };
