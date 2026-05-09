/**
 * ============================================================
 *  MatrixTrack – Supervisor Daily Report (WhatsApp)
 *  File: utils/msg91SupervisorDailyReport.js
 *
 *  ISOLATED: This file is completely independent.
 *  - Own template name, namespace, language config
 *  - Own DB queries — no existing routes touched
 *  - Own recipients list
 *  Template: matrixtrack_supervisor_report (23 variables)
 * ============================================================
 */

const axios = require("axios");
const pool = require("../config/db");

// ── Config ──────────────────────────────────────────────────
const BASE_URL = (
  process.env.MSG91_WHATSAPP_BASE_URL ||
  "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk"
).replace(/\/+$/, "");

const AUTH_KEY =
  process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;

const INTEGRATED_NUMBER = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER;

// ⚠️ UPDATE these after MSG91 approves the template
const TEMPLATE_NAME      = "matrixtrack_supervisor_report";
const TEMPLATE_NAMESPACE = "5c8f516b_8ec5_4384_bb73_3bfd7a369e84";
const TEMPLATE_LANGUAGE  = "en";

const REPORT_TIMEZONE = "Asia/Kolkata";

// ── Recipients (only these 2 numbers) ───────────────────────
// Format: 91XXXXXXXXXX (no + sign)
const SUPERVISOR_REPORT_RECIPIENTS = [];

// ── Date helper ─────────────────────────────────────────────
const getReportDates = () => {
  const nowUtc = new Date();
  const istNow = new Date(
    nowUtc.toLocaleString("en-US", { timeZone: REPORT_TIMEZONE })
  );

  // Today's date for the report (not yesterday, since this is a daily supervisor report)
  const isoDate = istNow.toISOString().slice(0, 10);
  const displayDate = new Date(`${isoDate}T00:00:00+05:30`).toLocaleDateString(
    "en-IN",
    { day: "2-digit", month: "short", year: "numeric", timeZone: REPORT_TIMEZONE }
  );

  // Week start = last Monday
  const dayOfWeek = istNow.getDay(); // 0=Sun,1=Mon,...,6=Sat
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const weekStart = new Date(istNow);
  weekStart.setDate(istNow.getDate() + diffToMonday);
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  return { isoDate, displayDate, weekStartIso };
};

// ── Format time helper ───────────────────────────────────────
const formatTime = (pgTime) => {
  if (!pgTime) return "N/A";
  try {
    const [h, m] = String(pgTime).split(":");
    const hour = parseInt(h, 10);
    const min = m || "00";
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    return `${displayHour}:${min} ${suffix}`;
  } catch (_) {
    return "N/A";
  }
};

// ── Fetch all supervisors with their ward/zone/kothi info ────
const fetchAllSupervisors = async () => {
  const query = `
    SELECT DISTINCT
      u.user_id,
      u.name        AS supervisor_name,
      u.phone       AS supervisor_mobile,
      w.ward_id,
      w.ward_name,
      z.zone_id,
      z.zone_name,
      c.city_id,
      c.city_name,
      w.ward_name   AS kothi_name
    FROM users u
    JOIN supervisor_ward sw ON sw.supervisor_id = u.user_id
    JOIN wards w ON w.ward_id = sw.ward_id
    JOIN zones z ON z.zone_id = w.zone_id
    JOIN cities c ON c.city_id = z.city_id
    WHERE u.role = 'supervisor'
      AND c.city_name = 'Pune'
    ORDER BY u.user_id, w.ward_id
  `;
  const { rows } = await pool.query(query);

  // Group by user_id — one supervisor may have multiple wards
  const supervisorMap = {};
  rows.forEach((row) => {
    if (!supervisorMap[row.user_id]) {
      supervisorMap[row.user_id] = {
        user_id:           row.user_id,
        supervisor_name:   row.supervisor_name,
        supervisor_mobile: row.supervisor_mobile,
        zone_name:         row.zone_name,
        zone_id:           row.zone_id,
        ward_name:         row.ward_name,
        kothi_name:        row.kothi_name,
        ward_ids:          [],
      };
    }
    supervisorMap[row.user_id].ward_ids.push(row.ward_id);
  });

  return Object.values(supervisorMap);
};

// ── Fetch today's attendance stats for a supervisor ──────────
const fetchTodayStats = async (wardIds, isoDate) => {
  const query = `
    SELECT
      COUNT(DISTINCT e.emp_id)                                           AS total_employees,
      COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL THEN e.emp_id END) AS present,
      COUNT(DISTINCT CASE WHEN a.leave_type    IS NOT NULL THEN e.emp_id END) AS on_leave,
      TO_CHAR(AVG(a.punch_in_time::time),  'HH24:MI')   AS avg_punch_in,
      TO_CHAR(AVG(a.punch_out_time::time), 'HH24:MI')   AS avg_punch_out,
      TO_CHAR(MIN(a.punch_in_time::time),  'HH24:MI')   AS earliest_in,
      TO_CHAR(MAX(a.punch_in_time::time),  'HH24:MI')   AS latest_in
    FROM employee e
    JOIN wards w ON w.ward_id = e.ward_id
    LEFT JOIN attendance a
      ON a.emp_id   = e.emp_id
     AND a.date::date = $1::date
    WHERE e.ward_id = ANY($2::int[])
  `;
  const { rows } = await pool.query(query, [isoDate, wardIds]);
  const row = rows[0] || {};

  const total   = Number(row.total_employees) || 0;
  const present = Number(row.present)         || 0;
  const onLeave = Number(row.on_leave)        || 0;
  const absent  = Math.max(total - present - onLeave, 0);
  const rate    = total > 0
    ? Number((((present + onLeave) / total) * 100).toFixed(1))
    : 0;

  return {
    total,
    present,
    onLeave,
    absent,
    rate,
    avgPunchIn:  formatTime(row.avg_punch_in),
    avgPunchOut: formatTime(row.avg_punch_out),
    earliestIn:  formatTime(row.earliest_in),
    latestIn:    formatTime(row.latest_in),
  };
};

// ── Fetch daily attendance % for each day of this week ───────
const fetchWeeklyStats = async (wardIds, weekStartIso, isoDate) => {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const results = {};

  for (let i = 0; i < 6; i++) {
    const dateObj  = new Date(`${weekStartIso}T00:00:00+05:30`);
    dateObj.setDate(dateObj.getDate() + i);
    const dayIso   = dateObj.toISOString().slice(0, 10);

    // Don't go beyond today
    if (dayIso > isoDate) {
      results[days[i]] = "—";
      continue;
    }

    const q = `
      SELECT
        COUNT(DISTINCT e.emp_id)                                                AS total,
        COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL OR a.leave_type IS NOT NULL
                            THEN e.emp_id END)                                  AS accounted
      FROM employee e
      LEFT JOIN attendance a
        ON a.emp_id = e.emp_id AND a.date::date = $1::date
      WHERE e.ward_id = ANY($2::int[])
    `;
    const { rows } = await pool.query(q, [dayIso, wardIds]);
    const row     = rows[0] || {};
    const total   = Number(row.total)     || 0;
    const present = Number(row.accounted) || 0;
    results[days[i]] = total > 0
      ? Number(((present / total) * 100).toFixed(1))
      : 0;
  }

  const nums = Object.values(results).filter((v) => typeof v === "number");
  const weekAvg = nums.length > 0
    ? Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1))
    : 0;

  return { ...results, weekAvg };
};

// ── Fetch zone rank for a supervisor ────────────────────────
const fetchZoneRank = async (supervisorUserId, zoneId, isoDate) => {
  try {
    const q = `
      WITH zone_supervisors AS (
        SELECT DISTINCT sw.supervisor_id
        FROM supervisor_ward sw
        JOIN wards w ON w.ward_id = sw.ward_id
        WHERE w.zone_id = $1
      ),
      sup_rates AS (
        SELECT
          zs.supervisor_id,
          CASE
            WHEN COUNT(DISTINCT e.emp_id) > 0
            THEN COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL OR a.leave_type IS NOT NULL
                                     THEN e.emp_id END)::float
                 / COUNT(DISTINCT e.emp_id)::float
            ELSE 0
          END AS rate
        FROM zone_supervisors zs
        JOIN supervisor_ward sw ON sw.supervisor_id = zs.supervisor_id
        JOIN employee e ON e.ward_id = sw.ward_id
        LEFT JOIN attendance a ON a.emp_id = e.emp_id AND a.date::date = $2::date
        GROUP BY zs.supervisor_id
      )
      SELECT
        supervisor_id,
        RANK() OVER (ORDER BY rate DESC) AS rank,
        COUNT(*) OVER ()                 AS total_supervisors
      FROM sup_rates
    `;
    const { rows } = await pool.query(q, [zoneId, isoDate]);
    const mine = rows.find((r) => Number(r.supervisor_id) === Number(supervisorUserId));
    return {
      rank:             mine ? Number(mine.rank)             : "—",
      totalSupervisors: mine ? Number(mine.total_supervisors) : rows.length,
    };
  } catch (_) {
    return { rank: "—", totalSupervisors: "—" };
  }
};

// ── Build MSG91 payload for one supervisor ───────────────────
const buildPayload = (phoneNumber, sup, today, week, rankData) => ({
  integrated_number: INTEGRATED_NUMBER,
  content_type: "template",
  payload: {
    messaging_product: "whatsapp",
    type: "template",
    template: {
      name:      TEMPLATE_NAME,
      namespace: TEMPLATE_NAMESPACE,
      language:  { policy: "deterministic", code: TEMPLATE_LANGUAGE },
      to_and_components: [
        {
          to: [phoneNumber],
          components: {
            body_1:  { type: "text", value: String(sup.supervisor_name) },         // {{1}} Name
            body_2:  { type: "text", value: String(sup.displayDate) },             // {{2}} Date
            body_3:  { type: "text", value: String(sup.zone_name) },               // {{3}} Zone
            body_4:  { type: "text", value: String(sup.ward_name) },               // {{4}} Ward
            body_5:  { type: "text", value: String(sup.kothi_name) },              // {{5}} Kothi
            body_6:  { type: "text", value: String(today.total) },                 // {{6}} Total
            body_7:  { type: "text", value: String(today.present) },               // {{7}} Present
            body_8:  { type: "text", value: String(today.absent) },                // {{8}} Absent
            body_9:  { type: "text", value: String(today.onLeave) },               // {{9}} On Leave
            body_10: { type: "text", value: String(today.rate) },                  // {{10}} Rate%
            body_11: { type: "text", value: String(today.avgPunchIn) },            // {{11}} Avg In
            body_12: { type: "text", value: String(today.avgPunchOut) },           // {{12}} Avg Out
            body_13: { type: "text", value: String(today.earliestIn) },            // {{13}} Earliest
            body_14: { type: "text", value: String(today.latestIn) },              // {{14}} Latest
            body_15: { type: "text", value: String(rankData.rank) },               // {{15}} Rank
            body_16: { type: "text", value: String(rankData.totalSupervisors) },   // {{16}} Total Sup
            body_17: { type: "text", value: String(week.Monday) },                 // {{17}} Mon
            body_18: { type: "text", value: String(week.Tuesday) },                // {{18}} Tue
            body_19: { type: "text", value: String(week.Wednesday) },              // {{19}} Wed
            body_20: { type: "text", value: String(week.Thursday) },               // {{20}} Thu
            body_21: { type: "text", value: String(week.Friday) },                 // {{21}} Fri
            body_22: { type: "text", value: String(week.Saturday) },               // {{22}} Sat
            body_23: { type: "text", value: String(week.weekAvg) },                // {{23}} Avg
          },
        },
      ],
    },
  },
});

// ── Main exported function ───────────────────────────────────
const sendSupervisorDailyReport = async () => {
  console.log("[SupervisorDailyReport] Starting report generation...");

  const { isoDate, displayDate, weekStartIso } = getReportDates();
  const supervisors = await fetchAllSupervisors();

  console.log(`[SupervisorDailyReport] Found ${supervisors.length} supervisors.`);

  for (const sup of supervisors) {
    try {
      const today    = await fetchTodayStats(sup.ward_ids, isoDate);
      const week     = await fetchWeeklyStats(sup.ward_ids, weekStartIso, isoDate);
      const rankData = await fetchZoneRank(sup.user_id, sup.zone_id, isoDate);

      // Add display date to sup object for payload builder
      sup.displayDate = displayDate;

      // Send to fixed recipient list (NOT each supervisor's own number yet)
      for (const mobile of SUPERVISOR_REPORT_RECIPIENTS) {
        const payload = buildPayload(mobile, sup, today, week, rankData);

        await axios.post(`${BASE_URL}/`, payload, {
          headers: {
            "Content-Type": "application/json",
            authkey: AUTH_KEY,
          },
          timeout: 15000,
        });

        console.log(`[SupervisorDailyReport] Sent for "${sup.supervisor_name}" to ${mobile}`);
      }
    } catch (err) {
      console.error(
        `[SupervisorDailyReport] Failed for supervisor ${sup.supervisor_name}:`,
        err.message
      );
    }
  }

  console.log("[SupervisorDailyReport] Done.");
  return { isoDate, count: supervisors.length };
};

module.exports = { sendSupervisorDailyReport };
