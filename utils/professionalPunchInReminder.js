const pool = require("../config/db");
const { ensureProfessionalLeaveSchema } = require("./professionalLeaveSchema");
const { sendPushToProfessionals } = require("./professionalPushService");

const REMINDER_MESSAGES = [
  // --- Set 1: Catchy & Fun ---
  {
    title: "⏰ Clock's ticking!",
    message: "Don't let your attendance ghost you. Punch in now! 👀",
  },
  {
    title: "💼 Work mode: ON?",
    message: "Your punch-in says otherwise. Tap to clock in! 🚀",
  },
  {
    title: "👋 Hey, busy bee!",
    message: "Looks like you're already working. Don't forget to punch in! 🐝",
  },
  {
    title: "⚡ Quick reminder!",
    message: "It takes 2 seconds to punch in... and saves a lot of explaining later. 😅",
  },
  {
    title: "🎯 Attendance check!",
    message: "Your shift is waiting, but your punch isn't. Tap to clock in.",
  },

  // --- Set 2: Direct & Engaging ---
  {
    title: "🤨 Your work started...",
    message: "But your attendance didn't. Let's fix that. 😉",
  },
  {
    title: "⌛ Every minute counts.",
    message: "Punch in before time outruns you.",
  },
  {
    title: "📍 You're at work, right?",
    message: "Make it official with a quick punch in.",
  },
  {
    title: "👀 Plot twist:",
    message: "You're working... but the system doesn't know yet. 😅",
  },
  {
    title: "🚨 Mission Pending!",
    message: "Complete your punch in to start today's attendance.",
  },

  // --- Set 3: Clever & Witty ---
  {
    title: "👀 We See You...",
    message: "Now let your attendance see you too. Mark it!",
  },
  {
    title: "🤔 Something's Missing",
    message: "You're here. Your attendance isn't.",
  },
  {
    title: "☕ Coffee? Check.",
    message: "Attendance? Still waiting.",
  },
  {
    title: "👻 Invisible Employee Mode",
    message: "Mark your attendance to become officially visible.",
  },
  {
    title: "🚨 Breaking News",
    message: "Your attendance is still pending. Plot twist?",
  },
  {
    title: "🎯 One Tap Away",
    message: "Your attendance won't mark itself... unfortunately.",
  },
];

const runProfessionalPunchInReminder = async (targetTime = null) => {
  const client = await pool.connect();
  try {
    await ensureProfessionalLeaveSchema();

    // Pick one message randomly daily
    const selectedReminder = REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)];

    let timeFilter = "";
    const params = [selectedReminder.title, selectedReminder.message];
    if (targetTime) {
      params.push(targetTime);
      timeFilter = ` AND COALESCE(pe.reminder_time, '10:00') = $3`;
    }

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
        $1,
        $2,
        jsonb_build_object(
          'reminder_date', ist_today.day::text,
          'category', 'attendance',
          'kind', 'missing-punch-in'
        )
      FROM professional_employees pe
      CROSS JOIN ist_today
      WHERE pe.is_active = true
        AND COALESCE(pe.reminder_enabled, true) = true
        ${timeFilter}
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
      RETURNING id, professional_id, type, title, message, metadata
    `;

    const result = await client.query(insertQuery, params);
    const sentCount = result.rowCount || 0;
    let pushSent = 0;
    let pushFailed = 0;
    let pushInvalidated = 0;

    if (sentCount > 0) {
      // 1. Send Device Push Notifications (Status Bar & Lock Screen via FCM / APNs)
      try {
        const pushResult = await sendPushToProfessionals(result.rows);
        pushSent = pushResult.sent || 0;
        pushFailed = pushResult.failed || 0;
        pushInvalidated = pushResult.invalidated || 0;
      } catch (pushError) {
        console.warn("[ProfessionalReminderCron] Push send failed:", pushError.message);
      }

      // 2. Also send SMS via AWS SNS if AWS credentials are configured
      if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY) {
        try {
          const { sendSms } = require("./smsNotifier");
          const targetProfIds = result.rows.map((r) => r.professional_id);
          const phoneRes = await client.query(
            `SELECT mobile_number FROM professional_employees WHERE id = ANY($1::uuid[]) AND mobile_number IS NOT NULL`,
            [targetProfIds]
          );
          for (const row of phoneRes.rows) {
            if (row.mobile_number) {
              sendSms({
                phone: row.mobile_number,
                message: `${selectedReminder.title}\n${selectedReminder.message}`,
                context: "general",
              }).catch((snsErr) =>
                console.warn("[ProfessionalReminderCron] AWS SNS SMS failed:", snsErr.message)
              );
            }
          }
        } catch (snsError) {
          console.warn("[ProfessionalReminderCron] AWS SNS integration check failed:", snsError.message);
        }
      }
    }

    console.log(
      `[ProfessionalReminderCron] In-app reminders: ${sentCount}, push sent: ${pushSent}, push failed: ${pushFailed}, push invalidated: ${pushInvalidated}`
    );
    return { sentCount, pushSent, pushFailed, pushInvalidated };
  } catch (error) {
    console.error("[ProfessionalReminderCron] Failed:", error.message);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { runProfessionalPunchInReminder };
