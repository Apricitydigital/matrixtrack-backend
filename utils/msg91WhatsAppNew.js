const axios = require("axios");
const pool = require("../config/db");

const BASE_URL = (process.env.MSG91_WHATSAPP_BASE_URL || "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk").replace(/\/+$/, "");
const AUTH_KEY = process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;
const TEMPLATE_NAMESPACE = "5c8f516b_8ec5_4384_bb73_3bfd7a369e84";
const TEMPLATE_NAME = "matrix_track_temp_mi";
const TEMPLATE_LANGUAGE = "en";
const INTEGRATED_NUMBER = "919111001035";

const REPORT_CITY = "Pune";
const REPORT_TIMEZONE = "Asia/Kolkata";

const getReportDates = () => {
  const nowUtc = new Date();
  const istNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: REPORT_TIMEZONE }));

  // Use YESTERDAY's date for the daily report
  const reportDate = new Date(istNow);
  reportDate.setDate(reportDate.getDate() - 1);

  const isoDate = reportDate.toISOString().slice(0, 10);
  const displayDate = reportDate.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: REPORT_TIMEZONE,
  });

  return { isoDate, displayDate };
};

const fetchCityReportData = async (date) => {
  // Fetch ALL face-registered employees in Pune (matching dashboard count: 10,713)
  const query = `
    SELECT
      dept.department_name,
      CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END AS is_present
    FROM employee e
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    LEFT JOIN designation des ON e.designation_id = des.designation_id
    LEFT JOIN department dept ON des.department_id = dept.department_id
    LEFT JOIN attendance a ON a.emp_id = e.emp_id AND a.date::date = $1::date
    WHERE c.city_name = $2
      AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
  `;

  const { rows } = await pool.query(query, [date, REPORT_CITY]);

  let cityStats = { total: rows.length, present: 0, absent: 0 };
  let rampStats = { total: 0, present: 0, absent: 0 };
  let pmcStats = { total: 0, present: 0, absent: 0 };

  rows.forEach(row => {
    const isPresent = row.is_present === 1;

    if (isPresent) cityStats.present++;

    const deptName = row.department_name || "";

    // Ramp Detection
    if (/ramp/i.test(deptName)) {
      rampStats.total++;
      if (isPresent) rampStats.present++;
    }

    // Road Sweeping Staff- PMC Detection
    if (/pmc/i.test(deptName) && /sweeping/i.test(deptName)) {
      pmcStats.total++;
      if (isPresent) pmcStats.present++;
    }
  });

  // Calculate Absents: Total - Present
  cityStats.absent = Math.max(cityStats.total - cityStats.present, 0);
  rampStats.absent = Math.max(rampStats.total - rampStats.present, 0);
  pmcStats.absent = Math.max(pmcStats.total - pmcStats.present, 0);

  return {
    city: cityStats,
    ramp: rampStats,
    pmc: pmcStats
  };
};

const sendDailyWhatsAppReportNew = async ({ phoneNumber }) => {
  if (!phoneNumber) throw new Error("phoneNumber is required.");

  const { isoDate, displayDate } = getReportDates();
  const data = await fetchCityReportData(isoDate);

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
            to: [phoneNumber],
            components: {
              body_1: { type: "text", value: String(REPORT_CITY) },
              body_2: { type: "text", value: String(displayDate) },
              body_3: { type: "text", value: String(data.city.total) },
              body_4: { type: "text", value: String(data.city.present) },
              body_5: { type: "text", value: String(data.city.absent) },
              body_6: { type: "text", value: String(data.ramp.total) },
              body_7: { type: "text", value: String(data.ramp.present) },
              body_8: { type: "text", value: String(data.ramp.absent) },
              body_9: { type: "text", value: String(data.pmc.total) },
              body_10: { type: "text", value: String(data.pmc.present) },
              body_11: { type: "text", value: String(data.pmc.absent) },
            },
          },
        ],
      },
    },
  };

  const response = await axios.post(`${BASE_URL}/`, payload, {
    headers: {
      "Content-Type": "application/json",
      authkey: AUTH_KEY,
    },
    timeout: 15000,
  });

  return {
    providerResponse: response.data,
    reportData: { ...data, date: displayDate },
  };
};

module.exports = {
  sendDailyWhatsAppReportNew,
};
