const axios = require("axios");
const pool = require("../config/db");
require("dotenv").config();

const AUTH_KEY = process.env.MSG91_AUTH_KEY;
const BASE_URL = "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
const INTEGRATED_NUMBER = "919111001035";
const TEMPLATE_NAME = "new_matrix_track_weekly_report";
const TEMPLATE_NAMESPACE = "5c8f516b_8ec5_4384_bb73_3bfd7a369e84";
const TEMPLATE_LANGUAGE = "en";
const REPORT_CITY = "Pune";

const getWeeklyDates = () => {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date();
  start.setDate(end.getDate() - 6); // Last 7 days
  start.setHours(0, 0, 0, 0);

  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  prevEnd.setHours(23, 59, 59, 999);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - 6);
  prevStart.setHours(0, 0, 0, 0);

  const formatDate = (d) => d.toLocaleDateString("en-GB", { day: '2-digit', month: 'short' });
  return {
    thisWeek: {
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
    },
    prevWeek: {
      startDate: prevStart.toISOString().split('T')[0],
      endDate: prevEnd.toISOString().split('T')[0],
    },
    displayPeriod: `${formatDate(start)} - ${formatDate(end)}`
  };
};

const fetchWeeklyReportData = async () => {
  const { thisWeek, prevWeek, displayPeriod } = getWeeklyDates();

  const commonJoins = `
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    JOIN designation des ON e.designation_id = des.designation_id
    JOIN department dept ON des.department_id = dept.department_id
  `;

  const commonFilter = `
    WHERE c.city_name = $3 
      AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
  `;

  // 1. Current Week Overview
  const overviewQuery = `
    WITH registered_total AS (
      SELECT COUNT(DISTINCT e.emp_id) as total_reg
      FROM employee e
      ${commonJoins}
      ${commonFilter}
    ),
    daily_present AS (
      SELECT 
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      ${commonJoins}
      ${commonFilter}
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY a.date::date
    )
    SELECT 
      (SELECT total_reg FROM registered_total) as avg_reg,
      ROUND(AVG(present_count)) as avg_pres
    FROM daily_present;
  `;

  // 2. Previous Week Overview (for trend)
  const prevOverviewQuery = `
    WITH daily_present AS (
      SELECT 
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      ${commonJoins}
      ${commonFilter}
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY a.date::date
    )
    SELECT ROUND(AVG(present_count)) as prev_avg_pres
    FROM daily_present;
  `;

  // 3. Top Zone, Ward, Kothi
  const areaLeaderQuery = `
    SELECT 
      z.zone_name,
      w.ward_name,
      COUNT(DISTINCT e.emp_id) as total,
      COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL THEN a.emp_id END) as present,
      ROUND((COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL THEN a.emp_id END)::numeric / NULLIF(COUNT(DISTINCT e.emp_id), 0)) * 100, 1) as perf
    FROM employee e
    ${commonJoins}
    LEFT JOIN attendance a ON e.emp_id = a.emp_id AND a.date::date BETWEEN $1 AND $2
    ${commonFilter}
    GROUP BY z.zone_name, w.ward_name
    ORDER BY perf DESC;
  `;

  // 4. Star Employees
  const starEmpQuery = `
    SELECT 
      e.name,
      COUNT(a.attendance_id) as days_present
    FROM employee e
    JOIN attendance a ON e.emp_id = a.emp_id
    ${commonJoins}
    ${commonFilter}
      AND a.date::date BETWEEN $1 AND $2 
      AND a.punch_in_time IS NOT NULL
    GROUP BY e.emp_id, e.name
    ORDER BY days_present DESC, MIN(a.punch_in_time) ASC
    LIMIT 3;
  `;

  // 5. Supervisor Analysis
  const supervisorQuery = `
    SELECT 
      u.name as supervisor_name,
      AVG(daily_perf.perf) as avg_perf
    FROM users u
    JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
    JOIN (
      SELECT 
        w.ward_id,
        a.date::date as d,
        (COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL THEN a.emp_id END)::numeric / NULLIF(COUNT(DISTINCT e.emp_id), 0)) * 100 as perf
      FROM employee e
      ${commonJoins}
      LEFT JOIN attendance a ON e.emp_id = a.emp_id AND a.date::date BETWEEN $1 AND $2
      ${commonFilter}
      GROUP BY w.ward_id, a.date::date
    ) daily_perf ON sw.ward_id = daily_perf.ward_id
    GROUP BY u.user_id, u.name
    ORDER BY avg_perf DESC;
  `;

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '60s'");

    const [overview, prevOverview, areaLeaders, stars, supervisors] = await Promise.all([
      client.query(overviewQuery, [thisWeek.startDate, thisWeek.endDate, REPORT_CITY]),
      client.query(prevOverviewQuery, [prevWeek.startDate, prevWeek.endDate, REPORT_CITY]),
      client.query(areaLeaderQuery, [thisWeek.startDate, thisWeek.endDate, REPORT_CITY]),
      client.query(starEmpQuery, [thisWeek.startDate, thisWeek.endDate, REPORT_CITY]),
      client.query(supervisorQuery, [thisWeek.startDate, thisWeek.endDate, REPORT_CITY]),
    ]);

    const stats = overview.rows[0] || { avg_reg: 0, avg_pres: 0 };
    const prevStats = prevOverview.rows[0] || { prev_avg_pres: 0 };
    
    const avgReg = stats.avg_reg || 0;
    const avgPres = stats.avg_pres || 0;
    const avgPresPct = avgReg > 0 ? Math.round((avgPres / avgReg) * 100) : 0;
    
    const avgAbsent = Math.max(0, avgReg - avgPres);
    const avgAbsentPct = Math.max(0, 100 - avgPresPct);

    // Weekly Trend Calculation
    const prevAvgPres = prevStats.prev_avg_pres || 0;
    const trendDiff = avgPres - prevAvgPres;
    const trendIndicator = ""; // Removed emoji
    const trendValue = `${Math.abs(trendDiff)} employees ${trendDiff >= 0 ? "more" : "fewer"} than last week`;

    const topZone = areaLeaders.rows.reduce((prev, current) => (prev.perf > current.perf) ? prev : current, areaLeaders.rows[0]);
    const topWard = areaLeaders.rows[0];
    const topKothis = areaLeaders.rows.slice(0, 3);
    
    const topSups = supervisors.rows.slice(0, 3);
    const bottomSups = supervisors.rows.slice(-3).reverse();

    return {
      city: REPORT_CITY,
      period: displayPeriod,
      avgReg,
      avgPres,
      avgPresPct,
      avgAbsent,
      avgAbsentPct,
      trendValue,
      trendIndicator,
      topZone: topZone?.zone_name || "N/A",
      topWard: topWard?.ward_name || "N/A",
      topKothis: topKothis.map(k => k.ward_name),
      topSupervisors: topSups.map(s => s.supervisor_name),
      bottomSupervisors: bottomSups.map(s => s.supervisor_name),
      starEmployees: stars.rows.map(s => s.name)
    };
  } finally {
    client.release();
  }
};

const sendWeeklyWhatsAppReportNew = async ({ phoneNumber }) => {
  const data = await fetchWeeklyReportData();

  const payload = {
    integrated_number: INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        namespace: TEMPLATE_NAMESPACE,
        language: { policy: "deterministic", code: TEMPLATE_LANGUAGE },
        to_and_components: [
          {
            to: [phoneNumber],
            components: {
              body_1: { type: "text", value: String(data.city) },
              body_2: { type: "text", value: String(data.period) },
              body_3: { type: "text", value: String(data.avgReg) },
              body_4: { type: "text", value: String(data.avgPres) },
              body_5: { type: "text", value: String(data.avgPresPct) },
              body_6: { type: "text", value: String(data.avgAbsent) },
              body_7: { type: "text", value: String(data.avgAbsentPct) },
              body_8: { type: "text", value: String(data.trendValue) },
              body_9: { type: "text", value: String(data.trendIndicator) },
              body_10: { type: "text", value: String(data.topZone) },
              body_11: { type: "text", value: String(data.topWard) },
              body_12: { type: "text", value: String(data.topKothis[0] || "N/A") },
              body_13: { type: "text", value: String(data.topKothis[1] || "N/A") },
              body_14: { type: "text", value: String(data.topKothis[2] || "N/A") },
              body_15: { type: "text", value: String(data.topSupervisors[0] || "N/A") },
              body_16: { type: "text", value: String(data.topSupervisors[1] || "N/A") },
              body_17: { type: "text", value: String(data.topSupervisors[2] || "N/A") },
              body_18: { type: "text", value: String(data.bottomSupervisors[0] || "N/A") },
              body_19: { type: "text", value: String(data.bottomSupervisors[1] || "N/A") },
              body_20: { type: "text", value: String(data.bottomSupervisors[2] || "N/A") },
              body_21: { type: "text", value: String(data.starEmployees[0] || "N/A") },
              body_22: { type: "text", value: String(data.starEmployees[1] || "N/A") },
              body_23: { type: "text", value: String(data.starEmployees[2] || "N/A") },
            },
          },
        ],
      },
    },
  };

  const response = await axios.post(BASE_URL, payload, {
    headers: { "Content-Type": "application/json", authkey: AUTH_KEY },
    timeout: 20000,
  });

  return { providerResponse: response.data, reportData: data };
};

module.exports = { sendWeeklyWhatsAppReportNew };
