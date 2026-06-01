require("dotenv").config();
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


process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

// const DEFAULT_TEST_NUMBERS = ["918827232995", "919131042937", "918982622996", "919111899909"];
// const NEW_REPORT_WEEKLY_RECIPIENTS = ["918827232995"];
const WEEKLY_REPORT_NEW_RECIPIENTS = ["918827232995", "919131042937", "918982622996", "919111899909", "919229499999", "918349733213"];

const todayKey = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });


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
if (AUTO_HEAL_CRON_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    "10 3 * * *", // 03:10 IST daily
    async () => {
      const client = await pool.connect();
      try {
        const AUTO_HEAL_LOCK_ID = 812349;
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [AUTO_HEAL_LOCK_ID]);
        if (!rows[0]?.locked) return;

        console.log("[AutoHealCron] Starting face healing process...");
        const scriptPath = path.join(__dirname, "auto_heal_faces.js");
        const child = spawn(process.execPath, [scriptPath], {
          stdio: "inherit",
          env: process.env,
        });
        child.on("exit", async (code) => {
          console.log(`[AutoHealCron] auto_heal_faces.js exited with code ${code}`);
          await client.query("SELECT pg_advisory_unlock($1)", [AUTO_HEAL_LOCK_ID]);
        });
      } catch (err) {
        console.error("[AutoHealCron] Error:", err.message);
      } finally {
        client.release();
      }
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
const { sendWeeklyWhatsAppReportNew } = require("./utils/msg91WhatsAppWeeklyNew");
// const { sendSupervisorDailyReport } = require("./utils/msg91SupervisorDailyReport");
const { sendDailyWhatsAppReportFinal } = require("./utils/msg91MatrixtrackDailyReport");
const { sendDailyBulletinWhatsAppNew } = require("./utils/msg91DailyBulletinNew");

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

if (isPrimaryCronInstance) {

  // =========================================================================
  // 📢 NEW DAILY BULLETIN REPORT (v2) - TRIGGERS TWICE DAILY AT 7:00 PM & 11:59 PM IST
  // =========================================================================
  const LAST_RUN_FILE_DAILY_V2 = path.join(__dirname, "whatsapp_report_daily_v2_last_run.txt");
  const hasSentTodayDailyV2 = (key) => {
    try {
      const stored = fs.readFileSync(LAST_RUN_FILE_DAILY_V2, "utf8").trim();
      return stored === key;
    } catch (err) {
      return false;
    }
  };
  const markSentTodayDailyV2 = (key) => {
    try {
      fs.writeFileSync(LAST_RUN_FILE_DAILY_V2, key, "utf8");
    } catch (err) {
      console.error("Unable to record Daily V2 WhatsApp send date:", err.message);
    }
  };

  // Helper to trigger SWM daily bulletin report
  const triggerDailyBulletinNew = async (triggerName, lockId) => {
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
      if (hasSentTodayDailyV2(runKey)) {
        console.log(`[WhatsApp Daily V2 Cron - ${triggerName}] Already sent today for ${triggerName}, skipping.`);
        return;
      }

      // 📝 EDIT RECIPIENT PHONE NUMBERS HERE:
      // You can add, remove, or edit phone numbers in this list to configure who receives the reports.
      const recipientsV2 = [
        "918827232995", // Admin 1  
        "919131042937", // Admin 2
        // Admin 3
        // "91XXXXXXXXXX", // Dummy number 1 (Uncomment and replace with real number)
        // "91YYYYYYYYYY", // Dummy number 2 (Uncomment and replace with real number)
        // "91ZZZZZZZZZZ", // Dummy number 3 (Uncomment and replace with real number)
      ];

      try {
        const { reportData } = await sendDailyBulletinWhatsAppNew({
          phoneNumber: recipientsV2,
          date: todayKey(), // Shared for the SAME DATE
        });
        console.log(`[WhatsApp Daily V2 Cron - ${triggerName}] Sent PMC SWM V2 Daily Bulletin in bulk to:`, recipientsV2.join(", "), 'for date:', reportData.date);
      } catch (error) {
        console.error(`[WhatsApp Daily V2 Cron - ${triggerName}] Failed bulk send V2:`, error.message);
      }

      markSentTodayDailyV2(runKey);

      await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
      lockAcquired = false;
    } catch (err) {
      console.error(`[WhatsApp Daily V2 Cron - ${triggerName}] Cron error:`, err.message);
    } finally {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
      }
      client.release();
    }
  };

  // ⏰ Trigger 1: 7:00 PM IST
  cron.schedule(
    "00 19 * * *",
    async () => {
      await triggerDailyBulletinNew("7pm", 812352);
    },
    {
      timezone: "Asia/Kolkata",
    }
  );

  // ⏰ Trigger 2: 11:59 PM IST
  cron.schedule(
    "59 23 * * *",
    async () => {
      await triggerDailyBulletinNew("1159pm", 812353);
    },
    {
      timezone: "Asia/Kolkata",
    }
  );


  // =============================================
  // NEW WEEKLY PERFORMANCE REPORT (9:45 AM IST) - ISOLATED
  // ISOLATED: own lock ID (812351), own tracking file
  // =============================================
  const LAST_RUN_FILE_WEEKLY_NEW = path.join(__dirname, "whatsapp_report_weekly_new_last_run.txt");
  const hasSentTodayWeeklyNew = (key) => {
    try {
      const stored = fs.readFileSync(LAST_RUN_FILE_WEEKLY_NEW, "utf8").trim();
      return stored === key;
    } catch (err) {
      return false;
    }
  };
  const markSentTodayWeeklyNew = (key) => {
    try {
      fs.writeFileSync(LAST_RUN_FILE_WEEKLY_NEW, key, "utf8");
    } catch (err) {
      console.error("Unable to record Weekly New WhatsApp send date:", err.message);
    }
  };

  cron.schedule(
    "45 09 * * 1", // Every Monday at 9:45 AM IST
    async () => {
      console.log('[WhatsApp Weekly New Cron] Weekly NEW performance report triggered');
      const client = await pool.connect();
      let lockAcquired = false;
      const WEEKLY_NEW_LOCK_ID = 812351; // Unique ID
      try {
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [WEEKLY_NEW_LOCK_ID]);
        lockAcquired = Boolean(rows[0]?.locked);

        if (!lockAcquired) {
          console.log("[WhatsApp Weekly New Cron] Another instance is handling send; skipping.");
          return;
        }

        const runKey = todayKey();
        if (hasSentTodayWeeklyNew(runKey)) {
          console.log("[WhatsApp Weekly New Cron] Already sent today, skipping.");
          return;
        }

        for (const mobile of WEEKLY_REPORT_NEW_RECIPIENTS) {
          try {
            const { reportData } = await sendWeeklyWhatsAppReportNew({
              phoneNumber: mobile,
            });
            console.log('[WhatsApp Weekly New Cron] Sent to:', mobile, reportData.period);
          } catch (error) {
            console.error('[WhatsApp Weekly New Cron] Failed for:', mobile, error.message);
          }
        }

        markSentTodayWeeklyNew(runKey);

        await client.query("SELECT pg_advisory_unlock($1)", [WEEKLY_NEW_LOCK_ID]);
        lockAcquired = false;
      } catch (err) {
        console.error('[WhatsApp Weekly New Cron] Cron error:', err.message);
      } finally {
        if (lockAcquired) {
          await client.query("SELECT pg_advisory_unlock($1)", [WEEKLY_NEW_LOCK_ID]);
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
