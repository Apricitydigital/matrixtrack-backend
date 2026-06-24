const pool = require("../config/db");
const axios = require("axios");
const {
  claimWhatsAppDispatch,
  releaseWhatsAppDispatch,
} = require("./whatsappDispatchGuard");

const BASE_URL = (process.env.MSG91_WHATSAPP_BASE_URL || "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk").replace(/\/+$/, "");
const AUTH_KEY = process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;
const TEMPLATE_NAMESPACE = "5c8f516b_8ec5_4384_bb73_3bfd7a369e84";
const TEMPLATE_NAME = "pune_swm_daily_bulletin_report_hms";
const TEMPLATE_LANGUAGE = "en";
const INTEGRATED_NUMBER = "919111001035";
const DISPATCH_REPORT_NAME = "pmc_swm_daily_bulletin";

const normalizePhoneNumber = (phoneNumber = "") => {
  const digits = String(phoneNumber).replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const REPORT_CITY = "Pune";
const REPORT_TIMEZONE = "Asia/Kolkata";

const formatNum = (num) => {
  return Number(num || 0).toLocaleString("en-IN");
};

const getReportDates = (overrideDate) => {
  let targetDateStr = overrideDate;
  if (!targetDateStr) {
    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    istTime.setDate(istTime.getDate() - 1); // Yesterday
    targetDateStr = istTime.toISOString().split("T")[0];
  }
  const reportDate = new Date(`${targetDateStr}T00:00:00+05:30`);
  const displayDate = reportDate.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: REPORT_TIMEZONE,
  });
  return { isoDate: targetDateStr, displayDate };
};

const hasMeaningfulBulletinData = (data) => {
  const totals = [
    data?.cityRegistered,
    data?.cityPresent,
    data?.cityLeave,
    data?.cityAbsent,
  ];

  const zoneHasData = Array.isArray(data?.zonesData)
    && data.zonesData.some((zone) => [zone.registered, zone.present, zone.leave, zone.absent]
      .some((value) => Number(value || 0) > 0));

  return totals.some((value) => Number(String(value).replace(/,/g, "") || 0) > 0) || zoneHasData;
};

const generateDailyBulletinData = async (overrideDate) => {
  const { isoDate, displayDate } = getReportDates(overrideDate);

  const cityQuery = `
    WITH attendance_summary AS (
      SELECT
        a.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS is_present,
        MAX(CASE WHEN a.leave_type IS NOT NULL AND a.punch_in_time IS NULL THEN 1 ELSE 0 END) AS is_on_leave,
        MAX(CASE WHEN a.mid_shift_punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_mid_shift_punch_in
      FROM attendance a
      WHERE a.date::date = $1::date
      GROUP BY a.emp_id
    )
    SELECT
      COUNT(DISTINCT e.emp_id) AS total_employees,
      COUNT(DISTINCT CASE WHEN e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL THEN e.emp_id END) AS total_face_registered,
      COUNT(DISTINCT CASE WHEN att.is_present = 1 THEN e.emp_id END) AS present,
      COUNT(DISTINCT CASE WHEN att.is_on_leave = 1 THEN e.emp_id END) AS on_leave,
      COUNT(DISTINCT CASE WHEN COALESCE(att.is_present, 0) = 0 AND COALESCE(att.is_on_leave, 0) = 0 THEN e.emp_id END) AS absent,
      COUNT(DISTINCT CASE WHEN att.has_mid_shift_punch_in = 1 THEN e.emp_id END) AS mid_shift_punch_in
    FROM employee e
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    LEFT JOIN attendance_summary att ON att.emp_id = e.emp_id
    WHERE c.city_name = $2
      AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
  `;

  const cityResult = await pool.query(cityQuery, [isoDate, REPORT_CITY]);
  const cityRow = cityResult.rows[0] || {};

  const cityRegistered = parseInt(cityRow.total_face_registered || 0, 10);
  const cityPresent = parseInt(cityRow.present || 0, 10);
  const cityLeave = parseInt(cityRow.on_leave || 0, 10);
  const cityAbsent = parseInt(cityRow.absent || 0, 10);
  const cityAttendanceRate = cityRegistered > 0 ? (cityPresent / cityRegistered) * 100 : 0;

  const zoneQuery = `
    WITH attendance_summary AS (
      SELECT
        a.emp_id,
        MAX(CASE WHEN a.punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS is_present,
        MAX(CASE WHEN a.leave_type IS NOT NULL AND a.punch_in_time IS NULL THEN 1 ELSE 0 END) AS is_on_leave,
        MAX(CASE WHEN a.mid_shift_punch_in_time IS NOT NULL THEN 1 ELSE 0 END) AS has_mid_shift_punch_in
      FROM attendance a
      WHERE a.date::date = $1::date
      GROUP BY a.emp_id
    )
    SELECT
      z.zone_name,
      COUNT(DISTINCT e.emp_id) AS total_employees,
      COUNT(DISTINCT CASE WHEN e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL THEN e.emp_id END) AS total_face_registered,
      COUNT(DISTINCT CASE WHEN att.is_present = 1 THEN e.emp_id END) AS present,
      COUNT(DISTINCT CASE WHEN att.is_on_leave = 1 THEN e.emp_id END) AS on_leave,
      COUNT(DISTINCT CASE WHEN COALESCE(att.is_present, 0) = 0 AND COALESCE(att.is_on_leave, 0) = 0 THEN e.emp_id END) AS absent,
      COUNT(DISTINCT CASE WHEN att.has_mid_shift_punch_in = 1 THEN e.emp_id END) AS mid_shift_punch_in
    FROM employee e
    JOIN wards w ON e.ward_id = w.ward_id
    JOIN zones z ON w.zone_id = z.zone_id
    JOIN cities c ON z.city_id = c.city_id
    LEFT JOIN attendance_summary att ON att.emp_id = e.emp_id
    WHERE c.city_name = $2
      AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
    GROUP BY z.zone_name, z.zone_id
    ORDER BY z.zone_name
  `;

  const { rows } = await pool.query(zoneQuery, [isoDate, REPORT_CITY]);

  if (!rows || rows.length === 0) {
    throw new Error(`No data found for Pune on date ${isoDate}.`);
  }

  const zonesData = rows.map((row) => {
    const registered = parseInt(row.total_face_registered || 0, 10);
    const present = parseInt(row.present || 0, 10);
    const leave = parseInt(row.on_leave || 0, 10);
    const absent = parseInt(row.absent || 0, 10);
    const presentRate = registered > 0 ? Math.round((present / registered) * 100) : 0;

    return {
      zoneName: row.zone_name,
      registered,
      present,
      leave,
      absent,
      presentRate,
    };
  });

  // Determine dynamic City Status and Description (Using % instead of "low")
  let statusText = "🟡 Attendance Variation Observed";
  let statusDesc = `City attendance stable overall, with ${cityAttendanceRate.toFixed(2)}% turnout across zones.`;

  if (cityAttendanceRate >= 70) {
    statusText = "🟢 Strong Attendance Observed";
    statusDesc = `City attendance stable and strong overall, with ${cityAttendanceRate.toFixed(2)}% turnout across zones.`;
  } else if (cityAttendanceRate < 50) {
    statusText = "🔴 Turnout Attention Required";
    statusDesc = `City attendance below average today, with ${cityAttendanceRate.toFixed(2)}% turnout across zones.`;
  }

  const sortedZones = [...zonesData].sort((a, b) => b.presentRate - a.presentRate);

  const overviewLines = sortedZones.map((zone, idx) => {
    let prefix = "";
    let suffix = "";
    if (idx === 0) {
      prefix = "🥇 ";
      suffix = " - highest attendance today 👏";
    } else if (idx === 1) {
      prefix = "🥈 ";
      suffix = " attendance";
    } else if (idx === 2) {
      prefix = "🥉 ";
    }

    const rateText = suffix ? `(${zone.presentRate}%${suffix})` : `(${zone.presentRate}%)`;
    return `${prefix}${zone.zoneName} — ${formatNum(zone.present)} present ${rateText}`;
  });

  const detailedZoneBlocks = zonesData.map((zone) => {
    return `🔹 ${zone.zoneName}\n• Registered: ${formatNum(zone.registered)}\n• Present: ${formatNum(zone.present)}\n• Leave: ${formatNum(zone.leave)}\n• Absent: ${formatNum(zone.absent)}`;
  });

  const lowestZone = zonesData.reduce((prev, curr) => (prev.presentRate < curr.presentRate ? prev : curr), zonesData[0]);

  const bottomZones = [...zonesData].sort((a, b) => a.presentRate - b.presentRate).slice(0, 2);
  const tomorrowFocusZonesStr = bottomZones.length >= 2 
    ? `${bottomZones[0].zoneName} and ${bottomZones[1].zoneName}` 
    : lowestZone.zoneName;

  // Pristine text preview for CLI / Logs (Matches the new template)
  const rawPreviewText = `🌆 PMC SWM Pune — Daily Bulletin
📅 ${displayDate}
Status: ${statusText}
${statusDesc}

City-wide Snapshot 👥
• Total Registered Workers: ${formatNum(cityRegistered)}
• Present Today: ${formatNum(cityPresent)}
• On Leave: ${formatNum(cityLeave)}
• Absent: ${formatNum(cityAbsent)}

Zone-wise Attendance Overview 📊
${overviewLines.join("\n")}

Detailed Zone Summary 🏙️
${detailedZoneBlocks.join("\n\n")}

Tomorrow’s Focus 🎯
✅ Improve attendance in high-absence wards, especially in ${tomorrowFocusZonesStr}.
—
Matrix Track Daily Bulletin | Human Matrix | PMC SWM Pune
Powered by Apricity Digital Labs Pvt Ltd`;

  return {
    date: displayDate,
    isoDate,
    statusText,
    statusDesc,
    cityRegistered: formatNum(cityRegistered),
    cityPresent: formatNum(cityPresent),
    cityLeave: formatNum(cityLeave),
    cityAbsent: formatNum(cityAbsent),
    sortedZones,
    zonesData,
    tomorrowFocusZonesStr,
    rawPreviewText,
    overviewLines,
  };
};

const sendDailyBulletinWhatsAppNew = async ({ phoneNumber, date, useDispatchGuard = false }) => {
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

  // 1. Generate SWM data
  const data = await generateDailyBulletinData(date);

  if (!hasMeaningfulBulletinData(data)) {
    throw new Error(
      `[Daily Bulletin] Refusing to send empty bulletin for ${data.isoDate} to ${recipients.join(",")}.`
    );
  }

  const dispatchIdentity = {
    reportName: DISPATCH_REPORT_NAME,
    reportDate: data.isoDate,
    recipientKey: [...recipients].sort().join(","),
  };

  if (useDispatchGuard) {
    const claimed = await claimWhatsAppDispatch(dispatchIdentity);
    if (!claimed) {
      return {
        skipped: true,
        reason: "duplicate_dispatch",
        reportData: data,
        phoneNumber: recipients.join(", "),
      };
    }
  }

  const getOverviewText = (idx) => {
    return data.overviewLines[idx] || "";
  };

  const getDetailedZone = (idx) => {
    return data.zonesData[idx] || { zoneName: "", registered: 0, present: 0, leave: 0, absent: 0 };
  };

  const z0 = getDetailedZone(0);
  const z1 = getDetailedZone(1);
  const z2 = getDetailedZone(2);
  const z3 = getDetailedZone(3);
  const z4 = getDetailedZone(4);

  // 2. Build MSG91 components (Strictly no newlines, layout is hardcoded in the template structure)
  const components = {
    body_1: { type: "text", value: String(data.date).trim() },
    body_2: { type: "text", value: String(data.statusText).trim() },
    body_3: { type: "text", value: String(data.statusDesc).trim() },
    
    body_4: { type: "text", value: String(data.cityRegistered).trim() },
    body_5: { type: "text", value: String(data.cityPresent).trim() },
    body_6: { type: "text", value: String(data.cityLeave).trim() },
    body_7: { type: "text", value: String(data.cityAbsent).trim() },
    
    // Zone Overview List
    body_8: { type: "text", value: String(getOverviewText(0)).trim() || "-" },
    body_9: { type: "text", value: String(getOverviewText(1)).trim() || "-" },
    body_10: { type: "text", value: String(getOverviewText(2)).trim() || "-" },
    body_11: { type: "text", value: String(getOverviewText(3)).trim() || "-" },
    body_12: { type: "text", value: String(getOverviewText(4)).trim() || "-" },
    
    // Detailed Zone 1
    body_13: { type: "text", value: String(z0.zoneName).trim() || "-" },
    body_14: { type: "text", value: String(formatNum(z0.registered)).trim() },
    body_15: { type: "text", value: String(formatNum(z0.present)).trim() },
    body_16: { type: "text", value: String(formatNum(z0.leave)).trim() },
    body_17: { type: "text", value: String(formatNum(z0.absent)).trim() },
    
    // Detailed Zone 2
    body_18: { type: "text", value: String(z1.zoneName).trim() || "-" },
    body_19: { type: "text", value: String(formatNum(z1.registered)).trim() },
    body_20: { type: "text", value: String(formatNum(z1.present)).trim() },
    body_21: { type: "text", value: String(formatNum(z1.leave)).trim() },
    body_22: { type: "text", value: String(formatNum(z1.absent)).trim() },
    
    // Detailed Zone 3
    body_23: { type: "text", value: String(z2.zoneName).trim() || "-" },
    body_24: { type: "text", value: String(formatNum(z2.registered)).trim() },
    body_25: { type: "text", value: String(formatNum(z2.present)).trim() },
    body_26: { type: "text", value: String(formatNum(z2.leave)).trim() },
    body_27: { type: "text", value: String(formatNum(z2.absent)).trim() },
    
    // Detailed Zone 4
    body_28: { type: "text", value: String(z3.zoneName).trim() || "-" },
    body_29: { type: "text", value: String(formatNum(z3.registered)).trim() },
    body_30: { type: "text", value: String(formatNum(z3.present)).trim() },
    body_31: { type: "text", value: String(formatNum(z3.leave)).trim() },
    body_32: { type: "text", value: String(formatNum(z3.absent)).trim() },
    
    // Detailed Zone 5
    body_33: { type: "text", value: String(z4.zoneName).trim() || "-" },
    body_34: { type: "text", value: String(formatNum(z4.registered)).trim() },
    body_35: { type: "text", value: String(formatNum(z4.present)).trim() },
    body_36: { type: "text", value: String(formatNum(z4.leave)).trim() },
    body_37: { type: "text", value: String(formatNum(z4.absent)).trim() },
    
    body_38: { type: "text", value: String(data.tomorrowFocusZonesStr).trim() },
  };

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

  try {
    const response = await axios.post(`${BASE_URL}/`, payload, {
      headers,
      timeout: 15000,
    });

    return {
      providerResponse: response.data,
      reportData: data,
      phoneNumber: recipients.join(", "),
    };
  } catch (error) {
    if (useDispatchGuard) {
      await releaseWhatsAppDispatch(dispatchIdentity);
    }
    throw error;
  }
};

module.exports = {
  generateDailyBulletinData,
  sendDailyBulletinWhatsAppNew,
  normalizePhoneNumber,
};
