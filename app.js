require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const cron = require("node-cron");
const { runAutoPunchOut } = require("./utils/autoPunchOutScheduler");
const { runProfessionalPunchInReminder } = require("./utils/professionalPunchInReminder");
const { runMigrations } = require("./db/migrations");
const pool = require("./config/db");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");
const socketio = require("./utils/socket");


process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
});

// const DEFAULT_TEST_NUMBERS = ["918827232995", "919131042937", "918982622996", "919111899909"];
const NEW_REPORT_WEEKLY_RECIPIENTS = ["918827232995"];

const todayKey = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });


// Import Routes
const authRoutes = require("./routes/authRoutes");
const allRoutes = require("./routes/index");
const appRoutes = require("./routes/appRoutes/index");
const selfAttendanceRoutes = require("./routes/appRoutes/newAttendaceRoutes");
const supervisorAadharRoutes = require("./routes/supervisorAadharRoutes");
const supervisorPhotoRoutes = require("./routes/supervisorPhotoRoutes");

const app = express();

const resolveTrustProxy = (rawValue) => {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized) return 1; // Default: one reverse proxy hop (nginx/load balancer)
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  return rawValue; // Allow values like "loopback, linklocal, uniquelocal"
};
const trustProxyValue = resolveTrustProxy(process.env.EXPRESS_TRUST_PROXY);
app.set("trust proxy", trustProxyValue);
console.log(`[HTTP] trust proxy = ${JSON.stringify(trustProxyValue)}`);

// Middleware
app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
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
  "https://uat.matrixtrack.in",
  "https://matrixtrack-uat.onrender.com",
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
// const { sendSupervisorDailyReport } = require("./utils/msg91SupervisorDailyReport");
const { sendDailyWhatsAppReportFinal } = require("./utils/msg91MatrixtrackDailyReport");

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

  // Daily Final Report Cron (9:30 AM IST) - ISOLATED
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
        if (hasSentTodayDailyFinal(runKey)) {
          console.log("[WhatsApp Daily Final Cron] Already sent today, skipping.");
          return;
        }

        const recipients = ["918827232995", "919131042937", "918982622996", "919111899909", "919229499999","918349733213"];
        
        for (const mobile of recipients) {
          try {
            const { reportData } = await sendDailyWhatsAppReportFinal({
              phoneNumber: mobile,
            });
            console.log('[WhatsApp Daily Final Cron] Sent to:', mobile, reportData.date);
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
          await client.query("SELECT pg_advisory_unlock($1)", [FINAL_DAILY_LOCK_ID]);
        }
        client.release();
      }
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
          await client.query("SELECT pg_advisory_unlock($1)", [WEEKLY_LOCK_ID]);
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
// Runs once daily at 9:00 PM IST.
// Set AUTO_PUNCHOUT_CRON_ENABLED=false in .env to disable.
// =======================
const AUTO_PUNCHOUT_CRON_ENABLED = process.env.AUTO_PUNCHOUT_CRON_ENABLED !== "false";
const AUTO_PUNCHOUT_CRON_EXPR = "0 21 * * *";
const PROFESSIONAL_PUNCH_IN_REMINDER_ENABLED =
  process.env.PROFESSIONAL_PUNCH_IN_REMINDER_ENABLED !== "false";
const PROFESSIONAL_PUNCH_IN_REMINDER_CRON_EXPR =
  process.env.PROFESSIONAL_PUNCH_IN_REMINDER_CRON_EXPR || "0 10 * * *";

if (AUTO_PUNCHOUT_CRON_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    AUTO_PUNCHOUT_CRON_EXPR,
    async () => {
      console.log("[AutoPunchOut Cron] ⏰ Daily 9:00 PM trigger started.");
      await runAutoPunchOut();
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log(`[AutoPunchOut Cron] ✅ Registered — schedule: "${AUTO_PUNCHOUT_CRON_EXPR}" (9:00 PM IST).`);
} else {
  console.log("[AutoPunchOut Cron] ⏭ Disabled or non-primary instance — skipping.");
}

if (PROFESSIONAL_PUNCH_IN_REMINDER_ENABLED && isPrimaryCronInstance) {
  cron.schedule(
    PROFESSIONAL_PUNCH_IN_REMINDER_CRON_EXPR,
    async () => {
      const client = await pool.connect();
      let lockAcquired = false;
      const REMINDER_LOCK_ID = 812351;
      try {
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [REMINDER_LOCK_ID]
        );
        lockAcquired = Boolean(rows[0]?.locked);
        if (!lockAcquired) {
          console.log("[ProfessionalReminderCron] Another instance is running; skipping.");
          return;
        }

        await runProfessionalPunchInReminder();
      } catch (error) {
        console.error("[ProfessionalReminderCron] Cron error:", error.message);
      } finally {
        if (lockAcquired) {
          await client.query("SELECT pg_advisory_unlock($1)", [REMINDER_LOCK_ID]);
        }
        client.release();
      }
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log(
    `[ProfessionalReminderCron] ✅ Registered — schedule: "${PROFESSIONAL_PUNCH_IN_REMINDER_CRON_EXPR}" (IST).`
  );
} else {
  console.log("[ProfessionalReminderCron] ⏭ Disabled or non-primary instance — skipping.");
}

// General API Route
app.get("/", (req, res) => {
  res.send("Attendance System API is running...");
});

// Auth Routes
app.post("/api/auth/check-duplicate", async (req, res) => {
  const { email, emp_code, phone, aadhar_number } = req.body;
  try {
    let emailExists = false;
    let empCodeExists = false;
    let phoneExists = false;
    let aadharExists = false;

    if (email) {
      const emailCheck = await pool.query("SELECT user_id FROM users WHERE email = $1 LIMIT 1", [email.trim().toLowerCase()]);
      emailExists = emailCheck.rowCount > 0;
    }
    if (emp_code) {
      const empCodeCheck = await pool.query("SELECT user_id FROM users WHERE emp_code = $1 LIMIT 1", [emp_code.trim()]);
      empCodeExists = empCodeCheck.rowCount > 0;
    }
    if (phone) {
      const phoneCheck = await pool.query("SELECT user_id FROM users WHERE phone = $1 LIMIT 1", [phone.trim()]);
      phoneExists = phoneCheck.rowCount > 0;
    }
    if (aadhar_number) {
      const aadharCheck = await pool.query("SELECT user_id FROM users WHERE aadhar_number = $1 LIMIT 1", [aadhar_number.trim()]);
      aadharExists = aadharCheck.rowCount > 0;
    }

    res.json({ emailExists, empCodeExists, phoneExists, aadharExists });
  } catch (error) {
    console.error("Duplicate check error:", error);
    res.status(500).json({ error: "Check failed" });
  }
});
app.use("/api/auth", authRoutes);

// Other Routes
app.use("/api", allRoutes);

// App Routes
app.use("/api/app", appRoutes);
app.use("/api/app/attendance/employee", selfAttendanceRoutes);
app.use("/api/supervisor-aadhar", supervisorAadharRoutes);
app.use("/api/supervisor-photo", supervisorPhotoRoutes);

// Start Server
const PORT = process.env.PORT || 5000;

// Create HTTP server and initialize Socket.io
const server = http.createServer(app);
socketio.init(server);

// Run migrations before starting the server
runMigrations().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Fatal: Migrations failed on startup", err);
  process.exit(1);
});
