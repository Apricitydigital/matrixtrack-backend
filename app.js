require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const cron = require("node-cron");
const { sendDailyWhatsAppReport } = require("./utils/msg91WhatsApp");
const { runAutoPunchOut } = require("./utils/autoPunchOutScheduler");
const { runMigrations } = require("./db/migrations");
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
const NEW_REPORT_RECIPIENTS = ["918827232995", "919131042937"];

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
const isPrimaryCronInstance =
  !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0";

const { sendDailyWhatsAppReportNew }       = require("./utils/msg91WhatsAppNew");
const { sendSupervisorDailyReport }        = require("./utils/msg91SupervisorDailyReport");

// ========= WHATSAPP NEW DEDUP =========
const LAST_RUN_FILE_NEW = path.join(__dirname, "whatsapp_report_new_last_run.txt");
const hasSentTodayNew = (key) => {
  try {
    const stored = fs.readFileSync(LAST_RUN_FILE_NEW, "utf8").trim();
    return stored === key;
  } catch (err) {
    return false;
  }
};
const markSentTodayNew = (key) => {
  try {
    fs.writeFileSync(LAST_RUN_FILE_NEW, key, "utf8");
  } catch (err) {
    console.error("Unable to record New WhatsApp send date:", err.message);
  }
};

if (isPrimaryCronInstance) {
  // Existing Report Cron (9:30 AM)
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

  // New Report Cron (1:20 PM)
  cron.schedule(
    "20 13 * * *",
    async () => {
      console.log('[WhatsApp New Cron] New Daily attendance report triggered');
      const client = await pool.connect();
      let lockAcquired = false;
      try {
        // Use a different lock ID for the new report
        const NEW_LOCK_ID = 812346;
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [NEW_LOCK_ID]);
        lockAcquired = Boolean(rows[0]?.locked);
        
        if (!lockAcquired) {
          console.log("[WhatsApp New Cron] Another instance is handling send; skipping.");
          return;
        }

        const runKey = todayKey();
        if (hasSentTodayNew(runKey)) {
          console.log("[WhatsApp New Cron] Already sent today, skipping.");
          return;
        }

        for (const mobile of NEW_REPORT_RECIPIENTS) {
          try {
            const { reportData } = await sendDailyWhatsAppReportNew({
              phoneNumber: mobile,
            });
            console.log('[WhatsApp New Cron] Sent to:', mobile, reportData.date);
          } catch (error) {
            console.error('[WhatsApp New Cron] Failed for:', mobile, error.message);
          }
        }

        markSentTodayNew(runKey);
        
        // Unlock
        await client.query("SELECT pg_advisory_unlock($1)", [NEW_LOCK_ID]);
        lockAcquired = false; 
      } catch (err) {
        console.error('[WhatsApp New Cron] Cron error:', err.message);
      } finally {
        if (lockAcquired) {
          // This would be reached only if lock was acquired but try/catch failed before explicit unlock
          await client.query("SELECT pg_advisory_unlock(812346)");
        }
        client.release();
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  // =============================================
  // Supervisor Daily Report Cron (8:00 PM IST)
  // ISOLATED: own lock ID (812347), own tracking file
  // Recipients: defined inside msg91SupervisorDailyReport.js
  // =============================================
  const LAST_RUN_FILE_SUP = path.join(__dirname, "whatsapp_report_supervisor_last_run.txt");
  const hasSentTodaySup = (key) => {
    try {
      const stored = fs.readFileSync(LAST_RUN_FILE_SUP, "utf8").trim();
      return stored === key;
    } catch (_) { return false; }
  };
  const markSentTodaySup = (key) => {
    try { fs.writeFileSync(LAST_RUN_FILE_SUP, key, "utf8"); }
    catch (err) { console.error("[SupervisorCron] Unable to record run date:", err.message); }
  };

  cron.schedule(
    "00 20 * * *",          // 8:00 PM IST daily
    async () => {
      console.log("[SupervisorCron] Supervisor daily report triggered.");
      const client = await pool.connect();
      let lockAcquired = false;
      const SUP_LOCK_ID = 812347;   // unique — never reuse this number
      try {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock($1) AS locked", [SUP_LOCK_ID]
        );
        lockAcquired = Boolean(rows[0]?.locked);
        if (!lockAcquired) {
          console.log("[SupervisorCron] Another instance running; skipping.");
          return;
        }

        const runKey = todayKey();
        if (hasSentTodaySup(runKey)) {
          console.log("[SupervisorCron] Already sent today; skipping.");
          return;
        }

        const result = await sendSupervisorDailyReport();
        markSentTodaySup(runKey);
        console.log(`[SupervisorCron] Done. Processed ${result.count} supervisors for ${result.isoDate}.`);

        await client.query("SELECT pg_advisory_unlock($1)", [SUP_LOCK_ID]);
        lockAcquired = false;
      } catch (err) {
        console.error("[SupervisorCron] Error:", err.message);
      } finally {
        if (lockAcquired) {
          await client.query("SELECT pg_advisory_unlock($1)", [SUP_LOCK_ID]);
        }
        client.release();
      }
    },
    { timezone: "Asia/Kolkata" }
  );

} else {
  console.log(
    `[WhatsApp Cron] Skipping cron registration on cluster instance ${process.env.NODE_APP_INSTANCE}`
  );
}

// =======================
// ⏰ AUTO PUNCH-OUT CRON
// Runs at the top of every hour.
// Keeps re-running for 10 minutes (every 30s) to catch all eligible employees.
// Set AUTO_PUNCHOUT_CRON_ENABLED=false in .env to disable.
// =======================
const AUTO_PUNCHOUT_CRON_ENABLED = process.env.AUTO_PUNCHOUT_CRON_ENABLED !== "false";
const AUTO_PUNCHOUT_CRON_EXPR = process.env.AUTO_PUNCHOUT_CRON_EXPR || "0 * * * *";

if (AUTO_PUNCHOUT_CRON_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    AUTO_PUNCHOUT_CRON_EXPR,
    async () => {
      console.log("[AutoPunchOut Cron] ⏰ Hourly trigger started — will run for 10 minutes.");
      


      const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
      const INTERVAL_MS = 30 * 1000;    // every 30 seconds
      const startTime = Date.now();

      // Run immediately on trigger
      await runAutoPunchOut();

      // Then repeat every 30s for 10 minutes
      const intervalId = setInterval(async () => {
        if (Date.now() - startTime >= WINDOW_MS) {
          clearInterval(intervalId);
          console.log("[AutoPunchOut Cron] ✅ 10-minute window complete. Stopping.");
          return;
        }
        await runAutoPunchOut();
      }, INTERVAL_MS);
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log(`[AutoPunchOut Cron] ✅ Registered — schedule: "${AUTO_PUNCHOUT_CRON_EXPR}", runs for 10 minutes.`);
} else {
  console.log("[AutoPunchOut Cron] ⏭ Disabled or non-primary instance — skipping.");
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

// Run migrations before starting the server
runMigrations().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Fatal: Migrations failed on startup", err);
  process.exit(1);
});
