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

const normalizePhoneNumber = (phoneNumber = "") => {
  const digits = String(phoneNumber).replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const fetchCityReportData = async (date) => {
  const query = `
    SELECT
      des.designation_name,
      COUNT(DISTINCT CASE WHEN e.face_embedding IS NOT NULL THEN e.emp_id END) as total,
      COUNT(DISTINCT CASE WHEN a.punch_in_time IS NOT NULL THEN e.emp_id END) as present,
      COUNT(DISTINCT CASE WHEN a.leave_type IS NOT NULL THEN e.emp_id END) as on_leave
    FROM employee e
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    JOIN designation des ON e.designation_id = des.designation_id
    JOIN department dept ON des.department_id = dept.department_id
    LEFT JOIN attendance a ON e.emp_id = a.emp_id AND a.date::date = $1::date
    WHERE c.city_name = $2
      AND dept.department_name = 'Road Sweeping Staff- PMC'
    GROUP BY des.designation_name
  `;

  const { rows } = await pool.query(query, [date, REPORT_CITY]);

  let cityStats = { total: 0, present: 0, onLeave: 0, absent: 0 };
  let rampStats = { total: 0, present: 0, onLeave: 0, absent: 0 };
  let pmcStats = { total: 0, present: 0, onLeave: 0, absent: 0 };

  rows.forEach(row => {
    const total = parseInt(row.total);
    const present = parseInt(row.present);
    const onLeave = parseInt(row.on_leave);
    const designation = row.designation_name || "";

    // Overall City Stats (All designations in this department)
    cityStats.total += total;
    cityStats.present += present;
    cityStats.onLeave += onLeave;

    // Ramp Breakdown (Strictly 'Ramp Bigari')
    if (/ramp\s*bigari/i.test(designation)) {
      rampStats.total += total;
      rampStats.present += present;
      rampStats.onLeave += onLeave;
    }

    // Road Sweeping PMC Breakdown (Strictly 'Road Sweeper')
    if (/road\s*sweeper/i.test(designation)) {
      pmcStats.total += total;
      pmcStats.present += present;
      pmcStats.onLeave += onLeave;
    }
  });

  // Calculate Absents: Total - (Present + OnLeave)
  cityStats.absent = Math.max(cityStats.total - (cityStats.present + cityStats.onLeave), 0);
  rampStats.absent = Math.max(rampStats.total - (rampStats.present + rampStats.onLeave), 0);
  pmcStats.absent = Math.max(pmcStats.total - (pmcStats.present + pmcStats.onLeave), 0);

  return {
    city: cityStats,
    ramp: rampStats,
    pmc: pmcStats
  };
};

const sendDailyWhatsAppReportNew = async ({ phoneNumber }) => {
  if (!phoneNumber) throw new Error("phoneNumber is required.");

  const normalizedPhone = normalizePhoneNumber(phoneNumber);
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
            to: [normalizedPhone],
            components: {
              body_1: { type: "text", value: String(REPORT_CITY) },
              body_2: { type: "text", value: String(displayDate) },
              body_3: { type: "text", value: String(data.city.total) },
              body_4: { type: "text", value: String(data.city.present) },
              body_5: { type: "text", value: `${data.city.absent} | On Leave: ${data.city.onLeave}` },
              body_6: { type: "text", value: String(data.ramp.total) },
              body_7: { type: "text", value: String(data.ramp.present) },
              body_8: { type: "text", value: `${data.ramp.absent} | On Leave: ${data.ramp.onLeave}` },
              body_9: { type: "text", value: String(data.pmc.total) },
              body_10: { type: "text", value: String(data.pmc.present) },
              body_11: { type: "text", value: `${data.pmc.absent} | On Leave: ${data.pmc.onLeave}` },
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
