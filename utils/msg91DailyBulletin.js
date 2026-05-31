const pool = require("../config/db");

const REPORT_CITY = "Pune";
const REPORT_TIMEZONE = "Asia/Kolkata";

/**
 * Format numbers with commas (e.g. 9821 -> "9,821")
 */
const formatNum = (num) => {
  return Number(num || 0).toLocaleString("en-IN");
};

/**
 * Helper to get report dates (Yesterday's date)
 */
const getReportDates = (overrideDate) => {
  if (overrideDate) {
    const reportDate = new Date(`${overrideDate}T00:00:00+05:30`);
    const displayDate = reportDate.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: REPORT_TIMEZONE,
    });
    return { isoDate: overrideDate, displayDate };
  }

  const nowUtc = new Date();
  const istNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: REPORT_TIMEZONE }));

  const reportDate = new Date(istNow);
  reportDate.setDate(reportDate.getDate() - 1); // Yesterday

  const isoDate = reportDate.toISOString().slice(0, 10);
  const displayDate = reportDate.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: REPORT_TIMEZONE,
  });

  return { isoDate, displayDate };
};

/**
 * Main function to retrieve live Pune SWM data and format the bulletin text
 */
const generateDailyBulletin = async (overrideDate) => {
  const { isoDate, displayDate } = getReportDates(overrideDate);

  const query = `
    SELECT
      z.zone_name,
      COUNT(DISTINCT CASE WHEN e.face_embedding IS NOT NULL THEN e.emp_id END) as registered,
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
    GROUP BY z.zone_name, z.zone_id
    ORDER BY z.zone_name
  `;

  const { rows } = await pool.query(query, [isoDate, REPORT_CITY]);

  if (!rows || rows.length === 0) {
    throw new Error(`No data found for Pune SWM department on date ${isoDate}.`);
  }

  // 1. Calculate City-wide Snapshot
  let cityRegistered = 0;
  let cityPresent = 0;
  let cityLeave = 0;

  const zonesData = rows.map((row) => {
    const registered = parseInt(row.registered || 0, 10);
    const present = parseInt(row.present || 0, 10);
    const leave = parseInt(row.on_leave || 0, 10);
    const absent = Math.max(registered - (present + leave), 0);
    const presentRate = registered > 0 ? Math.round((present / registered) * 100) : 0;

    cityRegistered += registered;
    cityPresent += present;
    cityLeave += leave;

    return {
      zoneName: row.zone_name,
      registered,
      present,
      leave,
      absent,
      presentRate,
    };
  });

  const cityAbsent = Math.max(cityRegistered - (cityPresent + cityLeave), 0);
  const cityAttendanceRate = cityRegistered > 0 ? (cityPresent / cityRegistered) * 100 : 0;

  // Determine dynamic City Status and Description
  let statusText = "🟡 Attendance Variation Observed";
  let statusDesc = "City attendance stable overall, with mixed turnout across zones.";

  if (cityAttendanceRate >= 70) {
    statusText = "🟢 Strong Attendance Observed";
    statusDesc = "City attendance stable and strong overall, with high turnout across zones.";
  } else if (cityAttendanceRate < 50) {
    statusText = "🔴 Turnout Attention Required";
    statusDesc = "City attendance below average today, with low turnout across zones.";
  }

  // 2. Sort Zones by performance (descending presentRate) to build Zone-wise Attendance Overview
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
    } else {
      prefix = "";
    }

    const rateText = suffix ? `(${zone.presentRate}%${suffix})` : `(${zone.presentRate}%)`;
    return `${prefix}${zone.zoneName} — ${formatNum(zone.present)} present ${rateText}`;
  });
  const zoneOverviewText = overviewLines.join("\n");

  // 3. Build Detailed Zone Summary blocks (Strictly matching clean spacing and bullets)
  const detailedZoneBlocks = zonesData.map((zone) => {
    return `🔹 ${zone.zoneName}\n\n  • Registered: ${formatNum(zone.registered)}\n  • Present: ${formatNum(zone.present)}\n  • Leave: ${formatNum(zone.leave)}\n  • Absent: ${formatNum(zone.absent)}`;
  });
  const detailedZoneText = detailedZoneBlocks.join("\n\n");

  // 4. Generate dynamic Key Observation based on thresholds (>= 65% presentRate) and lowest performer
  const strongZones = zonesData.filter((z) => z.presentRate >= 65).map((z) => z.zoneName);
  const lowestZone = zonesData.reduce((prev, curr) => (prev.presentRate < curr.presentRate ? prev : curr), zonesData[0]);

  let keyObservation = "";
  if (strongZones.length > 0) {
    const formattedStrong = strongZones.length === 1 
      ? strongZones[0] 
      : `${strongZones.slice(0, -1).join(", ")} and ${strongZones[strongZones.length - 1]}`;
    keyObservation = `${formattedStrong} delivered strong attendance performance above 65%, while ${lowestZone.zoneName} recorded the lowest turnout today and may require focused follow-up at ward level.`;
  } else {
    keyObservation = `All zones delivered attendance performance below 65%, with ${lowestZone.zoneName} recording the lowest turnout today and requiring focused follow-up at ward level.`;
  }

  // 5. Tomorrow's Focus and Manual Punch-out (targeting lowest performers)
  const bottomZones = [...zonesData].sort((a, b) => a.presentRate - b.presentRate).slice(0, 2);
  const tomorrowFocusZonesStr = bottomZones.length >= 2 
    ? `${bottomZones[0].zoneName} and ${bottomZones[1].zoneName}` 
    : lowestZone.zoneName;

  const secondLowestZone = bottomZones[1] || lowestZone;
  const manualPunchZonesStr = `${secondLowestZone.zoneName} and ${lowestZone.zoneName}`;

  // Assemble full text block for pristine preview in logs / response
  const rawPreviewText = `🌆 *PMC SWM Pune — Daily Bulletin* 
📅 ${displayDate}  Status: ${statusText}
${statusDesc}

City-wide Snapshot 👥

  • Total Registered Workers: ${formatNum(cityRegistered)}
  • Present Today: ${formatNum(cityPresent)}
  • On Leave: ${formatNum(cityLeave)}
  • Absent: ${formatNum(cityAbsent)}

Zone-wise Attendance Overview 📊

${zoneOverviewText}

Detailed Zone Summary 🏙️

${detailedZoneText}

Key Observation 🔍
${keyObservation}

Tomorrow’s Focus 🎯
✅ Improve attendance in high-absence wards, especially in ${tomorrowFocusZonesStr}.
✅ Review manual punch-out cases in ${manualPunchZonesStr}.
✅ Ensure timely attendance marking and shift completion across all wards.
✅ Strengthen supervisor-level monitoring for absentee workers.

—
Matrix Track Daily Bulletin | Human Matrix | PMC SWM Pune
Powered by Apricity Digital Labs Pvt Ltd`;

  return {
    date: displayDate,
    statusText,
    statusDesc,
    cityRegistered: formatNum(cityRegistered),
    cityPresent: formatNum(cityPresent),
    cityLeave: formatNum(cityLeave),
    cityAbsent: formatNum(cityAbsent),
    zoneOverviewText,
    detailedZoneText,
    keyObservation,
    tomorrowFocusZonesStr,
    manualPunchZonesStr,
    rawPreviewText,
  };
};

module.exports = {
  generateDailyBulletin,
};
