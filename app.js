require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const cron = require("node-cron");
const { sendDailyWhatsAppReport } = require("./utils/msg91WhatsApp");
const pool = require("./config/db");
const fs = require("fs");


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
];

const parseOrigins = (value) =>
  value?.split(",").map((o) => o.trim()).filter(Boolean);

const envOrigins = parseOrigins(process.env.FRONTEND_ORIGINS) || [];
const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

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
});
