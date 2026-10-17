const pool = require("../config/db");
const { ensureProfessionalLeaveSchema } = require("./professionalLeaveSchema");
const { sendPushToProfessionals } = require("./professionalPushService");
const { ensurePunchCutoffSchema } = require("./professionalPunchCutoff");
const REMINDER_JOB_LOCK_ID = 913421;
const configuredBatchSize = Number(process.env.PROFESSIONAL_REMINDER_BATCH_SIZE || 500);
const DEFAULT_BATCH_SIZE = Number.isFinite(configuredBatchSize)
  ? Math.min(1000, Math.max(50, Math.floor(configuredBatchSize)))
  : 500;
const REMINDER_SMS_ENABLED =
  process.env.PROFESSIONAL_REMINDER_SMS_ENABLED === "true";

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

const DEFAULT_REMINDER_TIME = "10:00";
// Recovery window for a brief cron/server interruption; reminders are due at
// the assigned time itself. This is independent of late-punch grace.
const REMINDER_CATCH_UP_MINUTES = 15;

const runProfessionalPunchInReminder = async (options = {}) => {
  const { verbose = false } = options;
  await ensurePunchCutoffSchema();
  await ensureProfessionalLeaveSchema({ expirePending: false });
  const client = await pool.connect();
  let locked = false;
  try {
    const lockResult = await client.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [REMINDER_JOB_LOCK_ID]
    );
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) {
      if (verbose) {
        console.log("[ProfessionalReminderCron] DB lock not acquired, skipping this run.");
      }
      return {
        sentCount: 0,
        pushSent: 0,
        pushFailed: 0,
        pushInvalidated: 0,
        pushNoDestination: 0,
        skipped: true,
      };
    }

    const params = [JSON.stringify(REMINDER_MESSAGES), DEFAULT_REMINDER_TIME, DEFAULT_BATCH_SIZE, REMINDER_CATCH_UP_MINUTES];
    const baseInsertQuery = `
      WITH ist_now AS (
        SELECT NOW() AT TIME ZONE 'Asia/Kolkata' AS local_now
      ),
      candidate_professionals AS MATERIALIZED (
        SELECT pe.id, ist_now.local_now::date AS reminder_date,
          COALESCE(t.cutoff_time,$2::time) AS reminder_time,
          floor(random()*jsonb_array_length($1::jsonb))::int AS message_index
        FROM professional_employees pe
        LEFT JOIN professional_punch_cutoffs t ON t.professional_id=pe.id
        CROSS JOIN ist_now
        WHERE pe.is_active = true AND pe.reminder_enabled IS DISTINCT FROM FALSE
          AND ist_now.local_now >= ist_now.local_now::date + COALESCE(t.cutoff_time,$2::time)
          AND ist_now.local_now < ist_now.local_now::date + COALESCE(t.cutoff_time,$2::time)
            + ($4::int + 1) * INTERVAL '1 minute'
          AND NOT professional_is_week_off(pe.id,ist_now.local_now::date)
          AND NOT EXISTS (
            SELECT 1 FROM professional_holidays h
            WHERE h.holiday_date=ist_now.local_now::date AND h.city_id=pe.city_id
              AND (h.zone_id IS NULL OR h.zone_id=pe.zone_id)
              AND (h.ward_id IS NULL OR h.ward_id=pe.ward_id)
              AND (h.kothi_id IS NULL OR h.kothi_id=pe.kothi_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM professional_attendance pa
            WHERE pa.professional_id=pe.id AND pa.date=ist_now.local_now::date
          )
          AND NOT EXISTS (
            SELECT 1 FROM professional_leave_requests plr
            WHERE plr.professional_id=pe.id AND plr.requested_date=ist_now.local_now::date AND plr.status='approved'
          )
          AND NOT EXISTS (
            SELECT 1 FROM professional_notifications pn
            WHERE pn.professional_id=pe.id AND pn.type='punch-in-reminder'
              AND COALESCE(pn.metadata->>'reminder_date','')=ist_now.local_now::date::text
          )
        ORDER BY pe.id LIMIT $3
      )
      INSERT INTO professional_notifications (professional_id,type,title,message,metadata)
      SELECT cp.id,'punch-in-reminder',
        ($1::jsonb->cp.message_index)->>'title',($1::jsonb->cp.message_index)->>'message',
        jsonb_build_object('reminder_date',cp.reminder_date::text,'reminder_time',to_char(cp.reminder_time,'HH24:MI'),
          'category','attendance','kind','missing-punch-in')
      FROM candidate_professionals cp
      RETURNING id,professional_id,type,title,message,metadata
    `;

    let sentCount = 0;
    let pushSent = 0;
    let pushFailed = 0;
    let pushInvalidated = 0;
    let pushNoDestination = 0;
    let batchCount = 0;

    while (true) {
      const result = await client.query(baseInsertQuery, params);
      const currentBatchCount = result.rowCount || 0;
      if (currentBatchCount === 0) break;

      batchCount += 1;
      sentCount += currentBatchCount;

      // 1. Send Device Push Notifications (Status Bar & Lock Screen via FCM / APNs)
      try {
        const pushResult = await sendPushToProfessionals(result.rows);
        pushSent += pushResult.sent || 0;
        pushFailed += pushResult.failed || 0;
        pushInvalidated += pushResult.invalidated || 0;
        pushNoDestination += pushResult.noDestination || 0;
      } catch (pushError) {
        console.warn("[ProfessionalReminderCron] Push send failed:", pushError.message);
      }

      // 2. SMS is opt-in only. Keep disabled by default to avoid cost/load spikes.
      if (
        REMINDER_SMS_ENABLED &&
        process.env.AWS_ACCESS_KEY &&
        process.env.AWS_SECRET_ACCESS_KEY
      ) {
        try {
          const { sendSms } = require("./smsNotifier");
          const targetProfIds = result.rows.map((r) => r.professional_id);
          const phoneRes = await client.query(
            `SELECT id,COALESCE(NULLIF(to_jsonb(pe)->>'mobile',''),to_jsonb(pe)->>'mobile_number') AS mobile_number FROM professional_employees pe WHERE id=ANY($1::uuid[])`,
            [targetProfIds]
          );
          for (const row of phoneRes.rows) {
            if (row.mobile_number) {
              const notification=result.rows.find(item=>item.professional_id===row.id);
              sendSms({
                phone: row.mobile_number,
                message: `${notification.title}\n${notification.message}`,
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

      if (currentBatchCount < DEFAULT_BATCH_SIZE) break;
    }

    if (verbose || sentCount > 0 || pushFailed > 0 || pushInvalidated > 0 || pushNoDestination > 0) {
      console.log(
        `[ProfessionalReminderCron] In-app reminders: ${sentCount}, batches: ${batchCount}, ` +
        `push sent: ${pushSent}, push failed: ${pushFailed}, ` +
        `push invalidated: ${pushInvalidated}, no destination: ${pushNoDestination}`
      );
    }
    return {
      sentCount,
      batchCount,
      pushSent,
      pushFailed,
      pushInvalidated,
      pushNoDestination,
    };
  } catch (error) {
    console.error("[ProfessionalReminderCron] Failed:", error.message);
    throw error;
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [REMINDER_JOB_LOCK_ID]);
    } catch (_) {}
    client.release();
  }
};

module.exports = {
  DEFAULT_REMINDER_TIME,
  REMINDER_CATCH_UP_MINUTES,
  runProfessionalPunchInReminder,
};
