require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const cron = require("node-cron");
const { runAutoPunchOut } = require("./utils/autoPunchOutScheduler");
const { runMigrations } = require("./db/migrations");
const pool = require("./config/db");
const fs = require("fs");
const { spawn } = require("child_process");
const socketUtil = require("./utils/socket");


process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

// const DEFAULT_TEST_NUMBERS = ["918827232995", "919131042937", "918982622996", "919111899909"];
const NEW_REPORT_WEEKLY_RECIPIENTS = ["918827232995"];
const CRON_RUNS_TABLE = "whatsapp_cron_runs";

const todayKey = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const ensureCronRunsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CRON_RUNS_TABLE} (
      job_name TEXT NOT NULL,
      run_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (job_name, run_key)
    )
  `);
};

const markCronRunStarted = async (client, jobName, runKey) => {
  const { rowCount } = await client.query(
    `
      INSERT INTO ${CRON_RUNS_TABLE} (job_name, run_key)
      VALUES ($1, $2)
      ON CONFLICT (job_name, run_key) DO NOTHING
    `,
    [jobName, runKey]
  );

  return rowCount === 1;
};


// Import Routes
const authRoutes = require("./routes/authRoutes");
const allRoutes = require("./routes/index");
const appRoutes = require("./routes/appRoutes/index");
const selfAttendanceRoutes = require("./routes/appRoutes/newAttendaceRoutes");
const supervisorAadharRoutes = require("./routes/supervisorAadharRoutes");
const supervisorPhotoRoutes = require("./routes/supervisorPhotoRoutes");
const otpRoutes = require("./routes/otpRoutes");
const compression = require("compression");

const app = express();

// Middleware
app.use(compression());
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});
// PROD SAFETY: 2 MB JSON limit. 8 MB was too large — allowed clients to bypass
// multer's file-size cap by encoding images as base64 in JSON body.
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
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
if (AUTO_HEAL_CRON_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    "10 3 * * *", // 03:10 IST daily
    () => {
      console.log("[AutoHealCron] Spawning face healing process...");
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

// ========= WHATSAPP WEEKLY DEDUP =========
const LAST_RUN_FILE_WEEKLY = path.join(__dirname, "whatsapp_report_weekly_last_run.txt");
const hasSentTodayWeekly = (key) => {
  try {
    const stored = fs.readFileSync(LAST_RUN_FILE_WEEKLY, "utf8").trim();
    return stored === key;
  } catch (err) {
    return false;
  }
};
const markSentTodayWeekly = (key) => {
  try {
    fs.writeFileSync(LAST_RUN_FILE_WEEKLY, key, "utf8");
  } catch (err) {
    console.error("Unable to record Weekly WhatsApp send date:", err.message);
  }
};

const { sendWeeklyWhatsAppReport } = require("./utils/msg91WhatsAppWeekly");
// const { sendSupervisorDailyReport } = require("./utils/msg91SupervisorDailyReport");
const { sendDailyWhatsAppReportFinal } = require("./utils/msg91MatrixtrackDailyReport");
const { sendDailyBulletinWhatsAppNew } = require("./utils/MT Daily Bulletin SWM pune");

const LAST_RUN_FILE_DAILY_FINAL = path.join(__dirname, "whatsapp_report_daily_final_last_run.txt");
const hasSentTodayDailyFinal = (key) => {
  try {
    const stored = fs.readFileSync(LAST_RUN_FILE_DAILY_FINAL, "utf8").trim();
    return stored === key;
  } catch (err) {
    return false;
  }
};
const markSentTodayDailyFinal = (key) => {
  try {
    fs.writeFileSync(LAST_RUN_FILE_DAILY_FINAL, key, "utf8");
  } catch (err) {
    console.error("Unable to record Daily Final WhatsApp send date:", err.message);
  }
};

const WHATSAPP_CRON_ENABLED = process.env.WHATSAPP_CRON_ENABLED === "true";
if (WHATSAPP_CRON_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    "30 09 * * *",
    async () => {
      console.log('[WhatsApp Daily Final Cron] Daily final attendance report triggered');
      const client = await pool.connect();
      let lockAcquired = false;
      const FINAL_DAILY_LOCK_ID = 812350; // Unique ID
      try {
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [FINAL_DAILY_LOCK_ID]);
        lockAcquired = Boolean(rows[0]?.locked);

        if (!lockAcquired) {
          console.log("[WhatsApp Daily Final Cron] Another instance is handling send; skipping.");
          return;
        }

        const runKey = todayKey();
        const runClaimed = await markCronRunStarted(client, "daily_final_report", runKey);
        if (!runClaimed) {
          console.log("[WhatsApp Daily Final Cron] Already claimed today, skipping.");
          return;
        }

        const recipients = ["918827232995", "919131042937", "918982622996", "919111899909", "919229499999", "918349733213"];

        for (const mobile of recipients) {
          try {
            const result = await sendDailyWhatsAppReportFinal({
              phoneNumber: mobile,
              useDispatchGuard: true,
            });
            if (result.skipped) {
              console.log('[WhatsApp Daily Final Cron] Duplicate suppressed for:', mobile, result.reportData.date);
            } else {
              console.log('[WhatsApp Daily Final Cron] Sent to:', mobile, result.reportData.date);
            }
          } catch (error) {
            console.error('[WhatsApp Daily Final Cron] Failed for:', mobile, error.message);
          }
        }

        markSentTodayDailyFinal(runKey);

        await client.query("SELECT pg_advisory_unlock($1)", [FINAL_DAILY_LOCK_ID]);
        lockAcquired = false;
      } catch (err) {
        console.error('[WhatsApp Daily Final Cron] Cron error:', err.message);
      } finally {
        if (lockAcquired) {
          try {
            await client.query("SELECT pg_advisory_unlock($1)", [FINAL_DAILY_LOCK_ID]);
          } catch (unlockErr) {
            console.error('[WhatsApp Daily Final Cron] Unlock error:', unlockErr.message);
          }
        }
        client.release();
      }
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  // =============================================
  // NEW DAILY BULLETIN REPORT (V2) - ISOLATED
  // =============================================
  // Helper to trigger SWM daily bulletin report
  const triggerDailyBulletinNew = async (triggerName, lockId, targetDate) => {
    console.log(`[WhatsApp Daily V2 Cron] Daily V2 bulletin report triggered for ${triggerName}`);
    const client = await pool.connect();
    let lockAcquired = false;
    try {
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockId]);
      lockAcquired = Boolean(rows[0]?.locked);

      if (!lockAcquired) {
        console.log(`[WhatsApp Daily V2 Cron - ${triggerName}] Another instance is handling V2 send; skipping.`);
        return;
      }

      const runKey = `${todayKey()}-${triggerName}`;
      const runClaimed = await markCronRunStarted(client, "daily_v2_bulletin", runKey);
      if (!runClaimed) {
        console.log(`[WhatsApp Daily V2 Cron - ${triggerName}] Already claimed today for ${triggerName}, skipping.`);
        return;
      }

      // You can add, remove, or edit phone numbers in this list to configure who receives the reports.
      const recipientsV2 = [
        "918827232995",
        "919111899909",//aditi ma'am
        "919371222202",//saheb sir
        "918007773301",//varule sir 
        "919229499999", //md sir 
        "918349733213",
        "919131042937"];

      const reportDate = targetDate || todayKey();

      try {
        const result = await sendDailyBulletinWhatsAppNew({
          phoneNumber: recipientsV2,
          date: reportDate, // Shared for the SAME DATE
          useDispatchGuard: true,
        });
        if (result.skipped) {
          console.log(`[WhatsApp Daily V2 Cron - ${triggerName}] Duplicate suppressed for date:`, result.reportData.date);
        } else {
          console.log(`[WhatsApp Daily V2 Cron - ${triggerName}] Sent PMC SWM V2 Daily Bulletin in bulk to:`, recipientsV2.join(", "), 'for date:', result.reportData.date);
        }
      } catch (error) {
        console.error(`[WhatsApp Daily V2 Cron - ${triggerName}] Failed bulk send V2:`, error.message);
      }

      await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
      lockAcquired = false;
    } catch (err) {
      console.error(`[WhatsApp Daily V2 Cron - ${triggerName}] Cron error:`, err.message);
    } finally {
      if (lockAcquired) {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        } catch (unlockErr) {
          console.error(`[WhatsApp Daily V2 Cron - ${triggerName}] Unlock error:`, unlockErr.message);
        }
      }
      client.release();
    }
  };

  // ⏰ Trigger: 9:00 AM IST (Sends yesterday's bulletin report)
  cron.schedule(
    "00 09 * * *",
    async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      await triggerDailyBulletinNew("9am", 812352, yesterday);
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  // Weekly Performance Report Cron (Every Monday at 10:00 AM IST)
  cron.schedule(
    "00 10 * * 1",
    async () => {
      console.log('[WhatsApp Weekly Cron] Weekly performance report triggered');
      const client = await pool.connect();
      let lockAcquired = false;
      const WEEKLY_LOCK_ID = 812348; // Unique ID for this report
      try {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock($1) AS locked", [WEEKLY_LOCK_ID]
        );
        lockAcquired = Boolean(rows[0]?.locked);
        if (!lockAcquired) {
          console.log("[WhatsApp Weekly Cron] Another instance is handling send; skipping.");
          return;
        }

        const runKey = todayKey();
        if (hasSentTodayWeekly(runKey)) {
          console.log("[WhatsApp Weekly Cron] Already sent today; skipping.");
          return;
        }

        // Recipients are defined at the top of app.js as NEW_REPORT_WEEKLY_RECIPIENTS
        for (const mobile of NEW_REPORT_WEEKLY_RECIPIENTS) {
          try {
            const { reportData } = await sendWeeklyWhatsAppReport({
              phoneNumber: mobile,
            });
            console.log('[WhatsApp Weekly Cron] Sent to:', mobile, reportData.period);
          } catch (error) {
            console.error('[WhatsApp Weekly Cron] Failed for:', mobile, error.message);
          }
        }

        markSentTodayWeekly(runKey);

        await client.query("SELECT pg_advisory_unlock($1)", [WEEKLY_LOCK_ID]);
        lockAcquired = false;
      } catch (err) {
        console.error('[WhatsApp Weekly Cron] Cron error:', err.message);
      } finally {
        if (lockAcquired) {
          try {
            await client.query("SELECT pg_advisory_unlock($1)", [WEEKLY_LOCK_ID]);
          } catch (unlockErr) {
            console.error('[WhatsApp Weekly Cron] Unlock error:', unlockErr.message);
          }
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
  /*
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
  */

} else {
  console.log(
    `[WhatsApp Cron] Skipping cron registration (WHATSAPP_CRON_ENABLED: ${process.env.WHATSAPP_CRON_ENABLED}, instance: ${process.env.NODE_APP_INSTANCE})`
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

// Mount IP Blocking Middleware
const ipBlockMiddleware = require("./middleware/ipBlockMiddleware");
app.use("/api", ipBlockMiddleware);

// Mount Global Audit Logger Middleware (Asynchronous S3 logging)
const auditLoggerMiddleware = require("./middleware/auditLoggerMiddleware");
app.use("/api", auditLoggerMiddleware);

// Biometric Proxy Route
const axios = require("axios");
app.get("/api/biometric-proxy", async (req, res) => {
  try {
    console.log("[Biometric Proxy] Fetching from source API...");
    const response = await axios.get("https://biometric.humanmatrix.online/all", {
      timeout: 30000 // 30s timeout
    });
    console.log(`[Biometric Proxy] Success! Fetched ${response.data?.records?.length || 0} records.`);
    res.json(response.data);
  } catch (error) {
    console.error("[Biometric Proxy] Error fetching:", error.message);
    res.status(500).json({ error: "Failed to fetch biometric data from source" });
  }
});

// Auth Routes
app.use("/api/auth", authRoutes);
app.use("/api/otp", otpRoutes);

// Other Routes
app.use("/api", allRoutes);

// App Routes
app.use("/api/app", appRoutes);
app.use("/api/app/attendance/employee", selfAttendanceRoutes);
app.use("/api/supervisor-aadhar", supervisorAadharRoutes);
app.use("/api/supervisor-photo", supervisorPhotoRoutes);

// Start Server
const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);

// Run migrations before starting the server
runMigrations().then(() => {
  return ensureCronRunsTable();
}).then(() => {
  // Initialize socket.io on the HTTP server
  socketUtil.init(httpServer);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Fatal: Migrations failed on startup", err);
  process.exit(1);
});
