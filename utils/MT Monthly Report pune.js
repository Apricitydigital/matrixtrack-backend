const pool = require("../config/db");
const axios = require("axios");

const BASE_URL = (process.env.MSG91_WHATSAPP_BASE_URL || "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk").replace(/\/+$/, "");
const AUTH_KEY = process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;
const TEMPLATE_NAMESPACE = "5c8f516b_8ec5_4384_bb73_3bfd7a369e84";
const TEMPLATE_NAME = "pune_activity_monthly_report";
const TEMPLATE_LANGUAGE = "en";
const INTEGRATED_NUMBER = "919111001035";

const normalizePhoneNumber = (phoneNumber = "") => {
  const digits = String(phoneNumber).replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const REPORT_CITY = "Pune";

const getMonthlyDates = (overrideMonth) => {
  let year, month;
  if (overrideMonth) {
    // Expected overrideMonth format: "YYYY-MM" or "YYYY-MM-DD"
    const parts = overrideMonth.split("-");
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10) - 1; // 0-indexed month
  } else {
    // Default to the previous month in IST timezone context
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    istTime.setMonth(istTime.getMonth() - 1);
    year = istTime.getFullYear();
    month = istTime.getMonth();
  }

  const startDate = new Date(Date.UTC(year, month, 1));
  const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));

  // Previous month dates for trend comparison
  const prevStartDate = new Date(Date.UTC(year, month - 1, 1));
  const prevEndDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const monthName = startDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = endDate.toISOString().split("T")[0];

  const prevStartStr = prevStartDate.toISOString().split("T")[0];
  const prevEndStr = prevEndDate.toISOString().split("T")[0];

  const displayPeriod = `${startDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} to ${endDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`;

  return {
    startDate: startStr,
    endDate: endStr,
    prevStartDate: prevStartStr,
    prevEndDate: prevEndStr,
    monthName,
    displayPeriod,
  };
};

const fetchMonthlyReportData = async (overrideMonth) => {
  const { startDate, endDate, prevStartDate, prevEndDate, monthName, displayPeriod } = getMonthlyDates(overrideMonth);

  // Queries are constructed to compute:
  // 1. Top Zone (average daily attendance rate)
  // 2. Top 5 Wards/Sectors (average daily attendance rate)
  // 3. Top 5 Kothis/Wards (average daily attendance rate)
  // 4. Top 5 Supervisors & Bottom 5 Supervisors (average daily attendance rate of their assigned wards)
  // 5. Monthly Attendance (overall average daily attendance rate for the city)
  // 6. Performance Trend (difference in average daily attendance rate between current month and previous month)

  const activeDatesSubquery = `
    SELECT DISTINCT a.date::date as d
    FROM attendance a
    JOIN employee e ON a.emp_id = e.emp_id
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    WHERE c.city_name = $3
      AND a.date::date BETWEEN $1 AND $2
      AND a.punch_in_time IS NOT NULL
  `;

  // 1. Zone performance query
  const zoneQuery = `
    WITH active_dates AS (${activeDatesSubquery}),
    zone_registered AS (
      SELECT 
        z.zone_name,
        COUNT(DISTINCT e.emp_id) as total_reg
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
      GROUP BY z.zone_name
    ),
    daily_zone_present AS (
      SELECT 
        z.zone_name,
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY z.zone_name, a.date::date
    ),
    zone_daily_perf AS (
      SELECT 
        zr.zone_name,
        ad.d,
        zr.total_reg,
        COALESCE(dzp.present_count, 0) as present_count
      FROM zone_registered zr
      CROSS JOIN active_dates ad
      LEFT JOIN daily_zone_present dzp ON zr.zone_name = dzp.zone_name AND ad.d = dzp.d
    )
    SELECT 
      zone_name,
      ROUND(AVG(CASE WHEN total_reg > 0 THEN (present_count::numeric / total_reg) * 100 ELSE 0 END), 2) as perf
    FROM zone_daily_perf
    GROUP BY zone_name
    ORDER BY perf DESC;
  `;

  // 2. Ward (Sector) performance query
  const wardQuery = `
    WITH active_dates AS (${activeDatesSubquery}),
    sector_registered AS (
      SELECT 
        s.sector_id,
        s.sector_name,
        COUNT(DISTINCT e.emp_id) as total_reg
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN sectors s ON w.sector_id = s.sector_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
      GROUP BY s.sector_id, s.sector_name
    ),
    daily_sector_present AS (
      SELECT 
        s.sector_id,
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN sectors s ON w.sector_id = s.sector_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY s.sector_id, a.date::date
    ),
    sector_daily_perf AS (
      SELECT 
        sr.sector_name,
        ad.d,
        sr.total_reg,
        COALESCE(dsp.present_count, 0) as present_count
      FROM sector_registered sr
      CROSS JOIN active_dates ad
      LEFT JOIN daily_sector_present dsp ON sr.sector_id = dsp.sector_id AND ad.d = dsp.d
    )
    SELECT 
      sector_name,
      ROUND(AVG(CASE WHEN total_reg > 0 THEN (present_count::numeric / total_reg) * 100 ELSE 0 END), 2) as perf
    FROM sector_daily_perf
    GROUP BY sector_name
    ORDER BY perf DESC
    LIMIT 5;
  `;

  // 3. Kothi (Ward) performance query
  const kothiQuery = `
    WITH active_dates AS (${activeDatesSubquery}),
    ward_registered AS (
      SELECT 
        w.ward_id,
        w.ward_name,
        COUNT(DISTINCT e.emp_id) as total_reg
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
      GROUP BY w.ward_id, w.ward_name
    ),
    daily_ward_present AS (
      SELECT 
        w.ward_id,
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY w.ward_id, a.date::date
    ),
    ward_daily_perf AS (
      SELECT 
        wr.ward_name,
        ad.d,
        wr.total_reg,
        COALESCE(dwp.present_count, 0) as present_count
      FROM ward_registered wr
      CROSS JOIN active_dates ad
      LEFT JOIN daily_ward_present dwp ON wr.ward_id = dwp.ward_id AND ad.d = dwp.d
    )
    SELECT 
      ward_name,
      ROUND(AVG(CASE WHEN total_reg > 0 THEN (present_count::numeric / total_reg) * 100 ELSE 0 END), 2) as perf
    FROM ward_daily_perf
    GROUP BY ward_name
    ORDER BY perf DESC
    LIMIT 5;
  `;

  // 4. Supervisor performance query
  const supervisorQuery = `
    WITH active_dates AS (${activeDatesSubquery}),
    ward_registered AS (
      SELECT 
        w.ward_id,
        COUNT(DISTINCT e.emp_id) as total_reg
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
      GROUP BY w.ward_id
    ),
    daily_ward_present AS (
      SELECT 
        w.ward_id,
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY w.ward_id, a.date::date
    ),
    ward_daily_perf AS (
      SELECT 
        wr.ward_id,
        ad.d,
        CASE WHEN wr.total_reg > 0 THEN (COALESCE(dwp.present_count, 0)::numeric / wr.total_reg) * 100 ELSE 0 END as perf
      FROM ward_registered wr
      CROSS JOIN active_dates ad
      LEFT JOIN daily_ward_present dwp ON wr.ward_id = dwp.ward_id AND ad.d = dwp.d
    )
    SELECT 
      u.name as supervisor_name,
      ROUND(AVG(wdp.perf), 2) as avg_perf
    FROM users u
    JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
    JOIN ward_daily_perf wdp ON sw.ward_id = wdp.ward_id
    GROUP BY u.user_id, u.name
    ORDER BY avg_perf DESC;
  `;

  // 5. City overall attendance query (Current Month)
  const cityAttendanceQuery = `
    WITH active_dates AS (${activeDatesSubquery}),
    city_registered AS (
      SELECT 
        COUNT(DISTINCT e.emp_id) as total_reg
      FROM employee e
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
    ),
    daily_city_present AS (
      SELECT 
        a.date::date as d,
        COUNT(DISTINCT a.emp_id) as present_count
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON e.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      WHERE c.city_name = $3
        AND a.date::date BETWEEN $1 AND $2
        AND a.punch_in_time IS NOT NULL
      GROUP BY a.date::date
    ),
    city_daily_perf AS (
      SELECT 
        ad.d,
        cr.total_reg,
        COALESCE(dcp.present_count, 0) as present_count
      FROM city_registered cr
      CROSS JOIN active_dates ad
      LEFT JOIN daily_city_present dcp ON ad.d = dcp.d
    )
    SELECT 
      ROUND(AVG(CASE WHEN total_reg > 0 THEN (present_count::numeric / total_reg) * 100 ELSE 0 END), 2) as avg_perf
    FROM city_daily_perf;
  `;

  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '60s'");

    const [zonesResult, wardsResult, kothisResult, supervisorsResult, cityResult, prevCityResult] = await Promise.all([
      client.query(zoneQuery, [startDate, endDate, REPORT_CITY]),
      client.query(wardQuery, [startDate, endDate, REPORT_CITY]),
      client.query(kothiQuery, [startDate, endDate, REPORT_CITY]),
      client.query(supervisorQuery, [startDate, endDate, REPORT_CITY]),
      client.query(cityAttendanceQuery, [startDate, endDate, REPORT_CITY]),
      client.query(cityAttendanceQuery, [prevStartDate, prevEndDate, REPORT_CITY]),
    ]);

    const topZone = zonesResult.rows[0]?.zone_name || "N/A";
    const topWards = wardsResult.rows;
    const topKothis = kothisResult.rows;

    const supervisors = supervisorsResult.rows;
    const topSupervisors = supervisors.slice(0, 5);
    const bottomSupervisors = supervisors.slice(-5).reverse();

    const monthlyAttendance = cityResult.rows[0]?.avg_perf ? parseFloat(cityResult.rows[0].avg_perf) : 0;
    const prevMonthlyAttendance = prevCityResult.rows[0]?.avg_perf ? parseFloat(prevCityResult.rows[0].avg_perf) : 0;

    // Trend calculation
    const trendDiff = monthlyAttendance - prevMonthlyAttendance;
    let trendText = "";
    if (trendDiff > 0) {
      trendText = `+${trendDiff.toFixed(2)}% increase in average daily turnout compared to last month`;
    } else if (trendDiff < 0) {
      trendText = `${trendDiff.toFixed(2)}% decrease in average daily turnout compared to last month`;
    } else {
      trendText = `0.00% change in average daily turnout compared to last month`;
    }

    return {
      monthName,
      displayPeriod,
      topZone,
      topWards,
      topKothis,
      topSupervisors,
      bottomSupervisors,
      monthlyAttendance: monthlyAttendance.toFixed(2),
      performanceTrend: trendText,
    };
  } finally {
    client.release();
  }
};

const sendMonthlyReportWhatsApp = async ({ phoneNumber, month }) => {
  if (!phoneNumber) {
    throw new Error("phoneNumber is required.");
  }

  let recipients = [];
  if (Array.isArray(phoneNumber)) {
    recipients = phoneNumber.map(normalizePhoneNumber).filter(Boolean);
  } else if (typeof phoneNumber === "string") {
    recipients = phoneNumber.split(",").map(normalizePhoneNumber).filter(Boolean);
  } else {
    recipients = [normalizePhoneNumber(phoneNumber)].filter(Boolean);
  }

  if (!recipients.length) {
    throw new Error("Valid phone number is required.");
  }

  // Generate monthly report data
  const data = await fetchMonthlyReportData(month);

  const getTopWardName = (idx) => {
    return data.topWards[idx] ? `${data.topWards[idx].sector_name} (${data.topWards[idx].perf}%)` : "-";
  };
  const getTopKothiName = (idx) => {
    return data.topKothis[idx] ? `${data.topKothis[idx].ward_name} (${data.topKothis[idx].perf}%)` : "-";
  };
  const getTopSupervisorName = (idx) => {
    return data.topSupervisors[idx] ? `${data.topSupervisors[idx].supervisor_name} (${data.topSupervisors[idx].avg_perf}%)` : "-";
  };
  const getBottomSupervisorName = (idx) => {
    return data.bottomSupervisors[idx] ? `${data.bottomSupervisors[idx].supervisor_name} (${data.bottomSupervisors[idx].avg_perf}%)` : "-";
  };

  const components = {
    body_1: { type: "text", value: String(data.monthName).trim() },
    body_2: { type: "text", value: String(data.displayPeriod).trim() },
    
    // Top Zone
    body_3: { type: "text", value: String(data.topZone).trim() },
    
    // Top 5 Wards
    body_4: { type: "text", value: String(getTopWardName(0)).trim() },
    body_5: { type: "text", value: String(getTopWardName(1)).trim() },
    body_6: { type: "text", value: String(getTopWardName(2)).trim() },
    body_7: { type: "text", value: String(getTopWardName(3)).trim() },
    body_8: { type: "text", value: String(getTopWardName(4)).trim() },
    
    // Top 5 Kothis
    body_9: { type: "text", value: String(getTopKothiName(0)).trim() },
    body_10: { type: "text", value: String(getTopKothiName(1)).trim() },
    body_11: { type: "text", value: String(getTopKothiName(2)).trim() },
    body_12: { type: "text", value: String(getTopKothiName(3)).trim() },
    body_13: { type: "text", value: String(getTopKothiName(4)).trim() },
    
    // Top 5 Supervisors
    body_14: { type: "text", value: String(getTopSupervisorName(0)).trim() },
    body_15: { type: "text", value: String(getTopSupervisorName(1)).trim() },
    body_16: { type: "text", value: String(getTopSupervisorName(2)).trim() },
    body_17: { type: "text", value: String(getTopSupervisorName(3)).trim() },
    body_18: { type: "text", value: String(getTopSupervisorName(4)).trim() },
    
    // Bottom 5 Supervisors
    body_19: { type: "text", value: String(getBottomSupervisorName(0)).trim() },
    body_20: { type: "text", value: String(getBottomSupervisorName(1)).trim() },
    body_21: { type: "text", value: String(getBottomSupervisorName(2)).trim() },
    body_22: { type: "text", value: String(getBottomSupervisorName(3)).trim() },
    body_23: { type: "text", value: String(getBottomSupervisorName(4)).trim() },
    
    // Monthly Attendance & Performance Trend
    body_24: { type: "text", value: String(data.monthlyAttendance).trim() },
    body_25: { type: "text", value: String(data.performanceTrend).trim() },
  };

  // Build rawPreviewText for logs and CLI testing
  const rawPreviewText = `MatrixTrack Monthly Report - ${data.monthName}
Date: ${data.displayPeriod}

🌟 Top Zone of the Month: ${data.topZone}

🌟 Top 5 Wards:
1. ${getTopWardName(0)}
2. ${getTopWardName(1)}
3. ${getTopWardName(2)}
4. ${getTopWardName(3)}
5. ${getTopWardName(4)}

🌟 Top 5 Kothis:
1. ${getTopKothiName(0)}
2. ${getTopKothiName(1)}
3. ${getTopKothiName(2)}
4. ${getTopKothiName(3)}
5. ${getTopKothiName(4)}

🌟 Top 5 Supervisors (Performance):
1. ${getTopSupervisorName(0)}
2. ${getTopSupervisorName(1)}
3. ${getTopSupervisorName(2)}
4. ${getTopSupervisorName(3)}
5. ${getTopSupervisorName(4)}

📉 Bottom 5 Supervisors:
1. ${getBottomSupervisorName(0)}
2. ${getBottomSupervisorName(1)}
3. ${getBottomSupervisorName(2)}
4. ${getBottomSupervisorName(3)}
5. ${getBottomSupervisorName(4)}

📊 Monthly Attendance: ${data.monthlyAttendance}%
📈 Performance Trend: ${data.performanceTrend}

━━━━━━━━━━━━━━━━━━
MatrixTrack — Real-Time Workforce Intelligence ✨
Powered by: Apricity Digital Labs Pvt. Ltd.`;

  const payload = {
    integrated_number: INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        namespace: TEMPLATE_NAMESPACE,
        language: {
          policy: "deterministic",
          code: TEMPLATE_LANGUAGE,
        },
        to_and_components: [
          {
            to: recipients,
            components,
          },
        ],
      },
    },
  };

  const headers = {
    "Content-Type": "application/json",
    authkey: AUTH_KEY,
  };

  const response = await axios.post(`${BASE_URL}/`, payload, {
    headers,
    timeout: 20000,
  });

  return {
    providerResponse: response.data,
    reportData: data,
    rawPreviewText,
    phoneNumber: recipients.join(", "),
  };
};

module.exports = {
  fetchMonthlyReportData,
  sendMonthlyReportWhatsApp,
  normalizePhoneNumber,
};
