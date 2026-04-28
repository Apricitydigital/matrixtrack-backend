require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const cron = require("node-cron");
const { sendDailyWhatsAppReport } = require("./utils/msg91WhatsApp");
const pool = require("./config/db");
const fs = require("fs");
const { spawn } = require("child_process");


process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});


// =======================
// 🧪 TEST MODE CONFIG
// =======================
// Dedup recipients so accidental repeats in env don't trigger multiple sends
const parseRecipients = (value) =>
  [...new Set(String(value || "").split(",").map((v) => v.trim()).filter(Boolean))];
const DEFAULT_RECIPIENTS = ["9131042937", "8319776925", "8982622996", "9111899909", "9371222202", "9229499999", "9340553792", "8007773301", "83088541510", "9730779278", "9689931759", "7620661125", "7722004567", "9013990014", "8349733213"];
const TEST_RECIPIENTS = parseRecipients(process.env.WHATSAPP_RECIPIENTS).length ? parseRecipients(process.env.WHATSAPP_RECIPIENTS) : DEFAULT_RECIPIENTS;

// ========= WHATSAPP DEDUP (one run per day) =========
const LAST_RUN_FILE = path.join(__dirname, "whatsapp_report_last_run.txt");
const todayKey = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const hasSentToday = (key) => {
  try {
    const stored = fs.readFileSync(LAST_RUN_FILE, "utf8").trim();
    return stored === key;
  } catch (err) {
    return false;
  }
};
const markSentToday = (key) => {
  try {
    fs.writeFileSync(LAST_RUN_FILE, key, "utf8");
  } catch (err) {
    console.error("Unable to record WhatsApp send date:", err.message);
  }
};

// DB-based lock so cron runs once even when multiple instances are up
const WHATSAPP_CRON_LOCK_ID = 812345; // arbitrary unique key
const acquireCronLock = async (client) => {
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [WHATSAPP_CRON_LOCK_ID]);
  return Boolean(rows[0]?.locked);
};
const releaseCronLock = async (client) => {
  await client.query("SELECT pg_advisory_unlock($1)", [WHATSAPP_CRON_LOCK_ID]);
};


// Import Routes
const authRoutes = require("./routes/authRoutes");
const allRoutes = require("./routes/index");
const appRoutes = require("./routes/appRoutes/index");
const selfAttendanceRoutes = require("./routes/appRoutes/newAttendaceRoutes");

const app = express();

// Middleware
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`); 
  next();
});
app.use(express.json());
const defaultOrigins = [
  "http://localhost:3000",
  "http://localhost:3002",
  "http://localhost:3001",
  "http://192.168.29.213:3000",
  "http://192.168.29.213:61960",
  "http://matrixtrack.duckdns.org:5000",
  "https://matrixtrack.duckdns.org:5000",
  "http://matrixtrack.duckdns.org",
  "https://matrixtrack.duckdns.org",
  "https://d30v7d7vnspm71.cloudfront.net",
  "http://attendease-frontend.s3-website.ap-south-1.amazonaws.com",
  "http://matrixtrackfrontend.s3-website.ap-south-1.amazonaws.com",
  "https://c68e-2405-201-300b-8910-9562-50d3-77c0-e73d.ngrok-free.app",
  "http://192.168.29.88:8081",
  "http://192.168.29.88:19000",
  "http://10.205.83.56:8081",
  "http://10.205.83.56:8082",
  "http://10.205.83.56:19000",
  "https://portal.matrixtrack.in",
  "https://api.matrixtrack.in",
];

const parseOrigins = (value) =>
  value?.split(",").map((o) => o.trim()).filter(Boolean);

const envOrigins = parseOrigins(process.env.FRONTEND_ORIGINS) || [];
const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];
const isPrimaryCronInstance =
  !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0";

// Nightly auto-heal for face embeddings (defaults ON; set AUTO_HEAL_CRON_ENABLED=false to disable)
const AUTO_HEAL_CRON_ENABLED = process.env.AUTO_HEAL_CRON_ENABLED !== "false";
if (AUTO_HEAL_CRON_ENABLED) {
  cron.schedule(
    "10 3 * * *", // 03:10 IST daily
    () => {
      const scriptPath = path.join(__dirname, "auto_heal_faces.js");
      const child = spawn(process.execPath, [scriptPath], {
        stdio: "inherit",
        env: process.env,
      });
      child.on("exit", (code) => {
        console.log(`[AutoHealCron] auto_heal_faces.js exited with code ${code}`);
      });
    },
    { timezone: "Asia/Kolkata" }
  );
}

// =======================
// ⏰ AUTO PUNCH-OUT CRON
// Runs every hour. Finds employees punched in > 9 hours ago
// with no punch-out and auto-closes their attendance.
// =======================
const AUTO_PUNCHOUT_HOURS = Number(process.env.AUTO_PUNCHOUT_HOURS ?? 9) || 9;
const AUTO_PUNCHOUT_CRON_ENABLED = process.env.AUTO_PUNCHOUT_CRON_ENABLED !== "false";
const AUTO_PUNCHOUT_LOCK_ID = 812346; // unique advisory lock id for auto punch-out
const AUTO_PUNCHOUT_BATCH_SIZE = Number(process.env.AUTO_PUNCHOUT_BATCH_SIZE ?? 300) || 300;
const AUTO_PUNCHOUT_LOOKBACK_DAYS =
  Number(process.env.AUTO_PUNCHOUT_LOOKBACK_DAYS ?? 2) || 2;

const runAutoPunchOutBatchJob = async (client) => {
  let totalUpdated = 0;

  while (true) {
    const result = await client.query(
      `WITH target AS (
         SELECT a.attendance_id
         FROM attendance a
         WHERE a.punch_in_time IS NOT NULL
           AND a.punch_out_time IS NULL
           AND COALESCE(a.is_auto_punch_out, FALSE) = FALSE
           AND a.punch_in_time < (NOW() AT TIME ZONE 'Asia/Kolkata') - ($1 * INTERVAL '1 hour')
           AND a.date >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - ($3 * INTERVAL '1 day'))
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
      [AUTO_PUNCHOUT_HOURS, AUTO_PUNCHOUT_BATCH_SIZE, AUTO_PUNCHOUT_LOOKBACK_DAYS]
    );

    totalUpdated += result.rowCount;
    if (result.rowCount < AUTO_PUNCHOUT_BATCH_SIZE) break;
  }

  return totalUpdated;
};

if (AUTO_PUNCHOUT_CRON_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    "0 * * * *", // Every hour at :00
    async () => {
      let client = null;
      let lockAcquired = false;
      try {
        client = await pool.connect();
        const lock = await client.query(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [AUTO_PUNCHOUT_LOCK_ID]
        );
        lockAcquired = Boolean(lock.rows[0]?.locked);
        if (!lockAcquired) {
          console.log("[AutoPunchOut] Another instance is handling this run; skipping.");
          return;
        }

        const totalUpdated = await runAutoPunchOutBatchJob(client);

        if (totalUpdated > 0) {
          console.log(
            `[AutoPunchOut] ✅ Auto-punched out ${totalUpdated} attendance row(s) after ${AUTO_PUNCHOUT_HOURS}h` +
              ` (batch=${AUTO_PUNCHOUT_BATCH_SIZE}, lookbackDays=${AUTO_PUNCHOUT_LOOKBACK_DAYS}).`
          );
        } else {
          console.log("[AutoPunchOut] No employees to auto punch-out at this hour.");
        }
      } catch (err) {
        // Log but never crash the cron runner
        console.error("[AutoPunchOut] ❌ Cron error:", err.message);
      } finally {
        try {
          if (client && lockAcquired) {
            await client.query("SELECT pg_advisory_unlock($1)", [AUTO_PUNCHOUT_LOCK_ID]);
          }
        } catch (unlockErr) {
          console.warn("[AutoPunchOut] Unlock warning:", unlockErr.message);
        } finally {
          if (client) client.release();
        }
      }
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log(`[AutoPunchOut] Cron registered — auto punch-out after ${AUTO_PUNCHOUT_HOURS}h, runs every hour.`);
} else if (AUTO_PUNCHOUT_CRON_ENABLED && !isPrimaryCronInstance) {
  console.log(
    `[AutoPunchOut] Skipping cron registration on cluster instance ${process.env.NODE_APP_INSTANCE}`
  );
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// =======================
// 🔔 REPORT / WHATSAPP CRON
// ⏰ 9:30 AM IST
// =======================
if (isPrimaryCronInstance) {
  cron.schedule(
    "30 09 * * *",
    async () => {
      console.log('[WhatsApp Cron] Daily attendance report triggered');
      const client = await pool.connect();
      let lockAcquired = false;
      try {
        lockAcquired = await acquireCronLock(client);
        if (!lockAcquired) {
          console.log("[WhatsApp Cron] Another instance is handling send; skipping.");
          return;
        }

        const runKey = todayKey();
        if (hasSentToday(runKey)) {
          console.log("[WhatsApp Cron] Already sent today, skipping.");
          return;
        }

        for (const mobile of TEST_RECIPIENTS) {
          try {
            const { reportData } = await sendDailyWhatsAppReport({
              phoneNumber: mobile,
            });
            console.log('[WhatsApp Cron] Sent to:', mobile, reportData.date);
          } catch (error) {
            console.error('[WhatsApp Cron] Failed for:', mobile, error.message);
          }
        }

        markSentToday(runKey);
      } catch (err) {
        console.error('[WhatsApp Cron] Cron error:', err.message);
      } finally {
        if (lockAcquired) {
          await releaseCronLock(client);
        }
        client.release();
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );
} else {
  console.log(
    `[WhatsApp Cron] Skipping cron registration on cluster instance ${process.env.NODE_APP_INSTANCE}`
  );
}

// General API Route
app.get("/", (req, res) => {
  res.send("Attendance System API is running...");
});

// Auth Routes
app.use("/api/auth", authRoutes);

// Other Routes
app.use("/api", allRoutes);

// App Routes
app.use("/api/app", appRoutes);
app.use("/api/app/attendance/employee", selfAttendanceRoutes);

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);

  // Run migration 5s after server starts — DB pool is warmed up by then
  setTimeout(async () => {
    const AUTO_PUNCHOUT_MIGRATION_ENABLED =
      process.env.AUTO_PUNCHOUT_MIGRATION_ENABLED !== "false";
    if (!AUTO_PUNCHOUT_MIGRATION_ENABLED) {
      console.log("[Migration] Skipped (AUTO_PUNCHOUT_MIGRATION_ENABLED=false).");
      return;
    }

    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 5000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let client = null;
      try {
        client = await pool.connect();

        // Quick existence check first to avoid unnecessary ALTER TABLE under load.
        const existsResult = await client.query(`
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'attendance'
            AND column_name = 'is_auto_punch_out'
          LIMIT 1;
        `);

        if (existsResult.rowCount > 0) {
          console.log("[Migration] ✅ attendance.is_auto_punch_out already present.");
          break;
        }

        // Run DDL with session-level timeout controls to avoid pool default 15s cancellation.
        await client.query("SET statement_timeout = 0");
        await client.query("SET lock_timeout = '5s'");
        await client.query(`
          ALTER TABLE attendance
            ADD COLUMN IF NOT EXISTS is_auto_punch_out BOOLEAN NOT NULL DEFAULT FALSE;
        `);
        console.log("[Migration] ✅ attendance.is_auto_punch_out column ensured.");
        break;
      } catch (migErr) {
        const msg = migErr?.message || "";
        const isRetryable =
          msg.includes("timeout") ||
          msg.includes("terminated") ||
          msg.includes("canceling statement") ||
          msg.includes("could not obtain lock");
        if (attempt < MAX_RETRIES && isRetryable) {
          console.warn(
            `[Migration] ⚠️  Attempt ${attempt}/${MAX_RETRIES} failed (${msg}). Retrying in ${
              RETRY_DELAY_MS / 1000
            }s...`
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          console.warn("[Migration] ⚠️  Warning (non-fatal):", msg);
          break;
        }
      } finally {
        if (client) {
          client.release();
        }
      }
    }
  }, 5000);
});
