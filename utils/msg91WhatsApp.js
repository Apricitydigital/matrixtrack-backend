const axios = require("axios");
const jwt = require("jsonwebtoken");

const BASE_URL =
  (process.env.MSG91_WHATSAPP_BASE_URL ||
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk").replace(
      /\/+$/,
      ""
    );
const AUTH_KEY =
  process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;
const TEMPLATE_NAMESPACE = process.env.MSG91_WHATSAPP_TEMPLATE_NAMESPACE;
const TEMPLATE_NAME = process.env.MSG91_WHATSAPP_TEMPLATE_NAME;
const TEMPLATE_LANGUAGE =
  process.env.MSG91_WHATSAPP_TEMPLATE_LANGUAGE || "en";
const INTEGRATED_NUMBER = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER;
const REQUEST_TIMEOUT = Number(
  process.env.MSG91_WHATSAPP_TIMEOUT_MS || 15000
);

const REPORT_CITY = "Pune";
const REPORT_TIMEZONE = "Asia/Kolkata";
const INTERNAL_BASE_URL = (
  process.env.INTERNAL_API_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || 5000}/api`
).replace(/\/+$/, "");
const INTERNAL_API_TIMEOUT = Number(
  process.env.INTERNAL_API_TIMEOUT_MS || 60000
);
const SERVICE_USER_ID = Number(process.env.WHATSAPP_REPORT_USER_ID || -1);
const SERVICE_USER_ROLE =
  process.env.WHATSAPP_REPORT_USER_ROLE || "admin";

const ensureConfig = () => {
  const missing = [];
  if (!AUTH_KEY) missing.push("MSG91_AUTH_KEY");
  if (!INTEGRATED_NUMBER) missing.push("MSG91_WHATSAPP_INTEGRATED_NUMBER");
  if (!TEMPLATE_NAMESPACE) missing.push("MSG91_WHATSAPP_TEMPLATE_NAMESPACE");
  if (!TEMPLATE_NAME) missing.push("MSG91_WHATSAPP_TEMPLATE_NAME");
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (missing.length) {
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  }
};

const normalizePhoneNumber = (phoneNumber = "") => {
  const digits = String(phoneNumber).replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  return digits;
};

const getReportDateIST = () => {
  const nowUtc = new Date();
  const istNow = new Date(
    nowUtc.toLocaleString("en-US", { timeZone: REPORT_TIMEZONE })
  );
  istNow.setDate(istNow.getDate() - 1);
  const isoDate = istNow.toISOString().slice(0, 10);
  const displayDate = new Date(`${isoDate}T00:00:00+05:30`).toLocaleDateString(
    "en-IN",
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: REPORT_TIMEZONE,
    }
  );
  return { isoDate, displayDate };
};

const buildServiceHeaders = () => {
  const token = jwt.sign(
    {
      user_id: SERVICE_USER_ID,
      role: SERVICE_USER_ROLE,
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
  return {
    Authorization: `Bearer ${token}`,
  };
};

const callInternalApi = async (path, params, headers) => {
  const url = `${INTERNAL_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await axios.get(url, {
    params,
    headers,
    timeout: INTERNAL_API_TIMEOUT,
  });
  return response.data;
};

const fetchCityAndZones = async (headers) => {
  const [citiesPayload, zonesPayload] = await Promise.all([
    callInternalApi("/cities", {}, headers),
    callInternalApi("/zones", {}, headers),
  ]);

  const cityList = Array.isArray(citiesPayload?.cities)
    ? citiesPayload.cities
    : Array.isArray(citiesPayload)
      ? citiesPayload
      : [];

  const targetCity = cityList.find(
    (city) =>
      String(city.city_name).trim().toLowerCase() ===
      REPORT_CITY.toLowerCase()
  );
  if (!targetCity) {
    throw new Error(`City "${REPORT_CITY}" not available for reporting.`);
  }

  const zoneList = Array.isArray(zonesPayload) ? zonesPayload : [];
  const cityZones = zoneList.filter(
    (zone) => String(zone.city_id) === String(targetCity.city_id)
  );
  if (!cityZones.length) {
    throw new Error(`No zones configured for city "${REPORT_CITY}".`);
  }

  return { city: targetCity, cityZones };
};

const extractDepartments = (rawValue = "") => {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((value) => String(value ?? ""))
      .flatMap((value) =>
        value
          .split(",")
          .map((dept) => dept.trim())
          .filter(Boolean)
      );
  }
  return String(rawValue ?? "")
    .split(",")
    .map((dept) => dept.trim())
    .filter(Boolean);
};

const normalizeDepartmentName = (name = "") =>
  String(name ?? "")
    .toLowerCase()
    .replace(/[–—-]/g, "-") // normalize hyphen-like characters
    .replace(/\s*-\s*/g, "-") // trim spaces around hyphens
    .replace(/\s+/g, " ")
    .trim();

const EXCLUDED_DEPARTMENTS = ["janwani workers", "unassigned"].map(
  normalizeDepartmentName
);

// Maps any allowed department name → one of the 4 canonical bucket names used
// in the WhatsApp template.  This ensures every employee is counted and the
// department sums always add up to the All Zone totals.
const CANONICAL_BUCKETS = [
  { name: "Ramp", regex: /ramp/i },
  { name: "Road Sweeping Staff- PMC", regex: /pmc/i },
  { name: "Road Sweeping Staff-Outsource", regex: /outsource/i },
];
const canonicalizeDept = (dept) => {
  for (const bucket of CANONICAL_BUCKETS) {
    if (bucket.regex.test(dept)) return bucket.name;
  }
  return "Swach Employees"; // HMS, Swach, anything else → here
};

const shouldIncludeRow = (row) => {
  const departments = extractDepartments(row.departments || row.department);
  if (!departments.length) {
    return true;
  }
  return departments.some(
    (dept) => !EXCLUDED_DEPARTMENTS.includes(normalizeDepartmentName(dept))
  );
};

const getAllowedDepartments = (row) => {
  const departments = extractDepartments(row.departments || row.department);
  return departments.filter(
    (dept) => !EXCLUDED_DEPARTMENTS.includes(normalizeDepartmentName(dept))
  );
};

const filterExcludedRows = (rows = []) =>
  rows.filter((row) => shouldIncludeRow(row));

const allocateCountsToMap = (targetMap, departments, present, absent) => {
  const targets = departments.length ? departments : ["Unassigned"];
  const count = targets.length;
  const basePresent = Math.floor(present / count);
  const presentRemainder = present - basePresent * count;
  const baseAbsent = Math.floor(absent / count);
  const absentRemainder = absent - baseAbsent * count;

  targets.forEach((dept, index) => {
    if (!targetMap.has(dept)) {
      targetMap.set(dept, { present: 0, absent: 0 });
    }
    const entry = targetMap.get(dept);
    entry.present += basePresent + (index < presentRemainder ? 1 : 0);
    entry.absent += baseAbsent + (index < absentRemainder ? 1 : 0);
  });
};

const getDepartmentCounts = (map, targetName) => {
  const normalizedTarget = normalizeDepartmentName(targetName);
  for (const [dept, counts] of map.entries()) {
    if (normalizeDepartmentName(dept) === normalizedTarget) {
      return {
        present: counts.present || 0,
        absent: counts.absent || 0,
      };
    }
  }
  return { present: 0, absent: 0 };
};

const fetchShortReportRows = async ({
  headers,
  cityName,
  zoneName,
  date,
}) => {
  const rows = await callInternalApi(
    "/attendance/short-report",
    { cityName, zoneName, date },
    headers
  );
  if (Array.isArray(rows)) {
    return rows;
  }
  return [];
};

const buildReportData = async () => {
  const { isoDate, displayDate } = getReportDateIST();
  const headers = buildServiceHeaders();
  const { city, cityZones } = await fetchCityAndZones(headers);

  const allRows = [];
  const zoneSummaries = [];
  const cityPresentSet = new Set();
  const cityRegisteredSet = new Set();
  const cityLeaveSet = new Set();

  for (const zone of cityZones) {
    const response = await fetchShortReportRows({
      headers,
      cityName: city.city_name,
      zoneName: zone.zone_name,
      date: isoDate,
    });
    const rows = filterExcludedRows(response);
    rows.forEach((row) => allRows.push(row));

    const departmentCounts = new Map();
    const departmentSet = new Set();
    const zonePresentSet = new Set();
    const zoneRegisteredSet = new Set();
    const zoneLeaveSet = new Set();

    rows.forEach((row) => {
      const presentIds = Array.isArray(row.present_emp_ids)
        ? row.present_emp_ids
        : [];
      const registeredIds = Array.isArray(row.registered_emp_ids)
        ? row.registered_emp_ids
        : [];
      const leaveIds = Array.isArray(row.leave_emp_ids)
        ? row.leave_emp_ids
        : [];

      presentIds.forEach((id) => {
        zonePresentSet.add(String(id));
        cityPresentSet.add(String(id));
      });
      registeredIds.forEach((id) => {
        zoneRegisteredSet.add(String(id));
        cityRegisteredSet.add(String(id));
      });
      leaveIds.forEach((id) => {
        zoneLeaveSet.add(String(id));
        cityLeaveSet.add(String(id));
      });

      const allowedDepartments = getAllowedDepartments(row);
      // Canonicalize so every employee lands in one of the 4 known buckets
      const deptsForAlloc =
        allowedDepartments.length > 0
          ? [...new Set(allowedDepartments.map(canonicalizeDept))]
          : ["Swach Employees"];

      const totalPresent = presentIds.length || 0;
      const totalRegistered = registeredIds.length || 0;
      // Absent = everyone not present (incl. on-leave) so dept sums match All Zone
      const absent = Math.max(totalRegistered - totalPresent, 0);

      deptsForAlloc.forEach((dept) => departmentSet.add(dept));
      allocateCountsToMap(
        departmentCounts,
        deptsForAlloc,
        totalPresent,
        absent
      );
    });

    const zonePresent = zonePresentSet.size;
    const zoneLeave = zoneLeaveSet.size;
    const zoneRegistered = zoneRegisteredSet.size;
    const zoneAbsent = Math.max(zoneRegistered - zonePresent - zoneLeave, 0);

    zoneSummaries.push({
      zoneName: zone.zone_name,
      present: zonePresent,
      leave: zoneLeave,
      absent: zoneAbsent,
      departmentCounts,
      departments: Array.from(departmentSet),
    });
  }

  // Raw unique employee count (kept for reference; the message uses category sums below)
  const cityTotalRegistered = cityRegisteredSet.size;

  const departmentCounts = new Map();
  allRows.forEach((row) => {
    const allowedDepartments = getAllowedDepartments(row);
    // Canonicalize so every employee lands in one of the 4 known buckets
    const deptsForAlloc =
      allowedDepartments.length > 0
        ? [...new Set(allowedDepartments.map(canonicalizeDept))]
        : ["Swach Employees"];
    const totalPresent = Array.isArray(row.present_emp_ids)
      ? row.present_emp_ids.length
      : Number(row.total_present_employees) || 0;
    const totalRegistered = Array.isArray(row.registered_emp_ids)
      ? row.registered_emp_ids.length
      : Number(row.total_registered_employees) || 0;
    // Absent = everyone not present (incl. on-leave) so dept sums match All Zone
    const absent = Math.max(totalRegistered - totalPresent, 0);

    allocateCountsToMap(departmentCounts, deptsForAlloc, totalPresent, absent);
  });

  const ramp = getDepartmentCounts(departmentCounts, "Ramp");
  const pmc = getDepartmentCounts(
    departmentCounts,
    "Road Sweeping Staff- PMC"
  );
  const outsource = getDepartmentCounts(
    departmentCounts,
    "Road Sweeping Staff-Outsource"
  );
  const swach = getDepartmentCounts(departmentCounts, "Swach Employees");

  // All Zone totals
  // Present  = sum of the 4 canonical department buckets (all employees are
  //            now mapped into one of these, so no one is missed).
  // Absent   = actual total registered − present  (everyone not present,
  //            incl. on-leave, which mirrors how dept-row absent is computed).
  // Registered = actual unique employee count.
  // This guarantees: dept Present sums == All Zone Present
  //                  dept Absent  sums == All Zone Absent
  //                  Registered        == Present + Absent
  const categoryPresentSum =
    ramp.present + pmc.present + outsource.present + swach.present;

  const totalRegisteredAcrossZones = cityTotalRegistered;
  const totalPresentAcrossZones = categoryPresentSum;
  const totalAbsentAcrossZones = Math.max(
    totalRegisteredAcrossZones - totalPresentAcrossZones, 0
  );

  return {
    city: city.city_name,
    date: displayDate,
    registered: totalRegisteredAcrossZones,
    present: totalPresentAcrossZones,
    absent: totalAbsentAcrossZones,
    rampPresent: ramp.present,
    rampAbsent: ramp.absent,
    pmcPresent: pmc.present,
    pmcAbsent: pmc.absent,
    outsourcePresent: outsource.present,
    outsourceAbsent: outsource.absent,
    swachPresent: swach.present,
    swachAbsent: swach.absent,
  };
};

const buildPayload = (phoneNumber, reportData) => ({
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
            body_1: { type: "text", value: String(reportData.city) },
            body_2: { type: "text", value: String(reportData.date) },
            body_3: { type: "text", value: String(reportData.registered) },
            body_4: { type: "text", value: String(reportData.present) },
            body_5: { type: "text", value: String(reportData.absent) },
            body_6: { type: "text", value: String(reportData.rampPresent) },
            body_7: { type: "text", value: String(reportData.rampAbsent) },
            body_8: { type: "text", value: String(reportData.pmcPresent) },
            body_9: { type: "text", value: String(reportData.pmcAbsent) },
            body_10: {
              type: "text",
              value: String(reportData.outsourcePresent),
            },
            body_11: {
              type: "text",
              value: String(reportData.outsourceAbsent),
            },
            body_12: {
              type: "text",
              // The MSG91 template already contains the word "Present" for this
              // field, so we must NOT include it here to avoid "Present Present".
              value: `${reportData.swachPresent}, Absent ${reportData.swachAbsent}`,
            },
          },
        },
      ],
    },
  },
});

const sendDailyWhatsAppReport = async ({ phoneNumber }) => {
  if (!phoneNumber) {
    throw new Error("phoneNumber is required.");
  }

  ensureConfig();

  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  if (!normalizedPhone) {
    throw new Error("Valid phone number is required.");
  }

  const reportData = await buildReportData();
  const payload = buildPayload(normalizedPhone, reportData);

  const response = await axios.post(`${BASE_URL}/`, payload, {
    headers: {
      "Content-Type": "application/json",
      authkey: AUTH_KEY,
    },
    timeout: REQUEST_TIMEOUT,
  });

  return {
    providerResponse: response.data,
    reportData,
  };
};

module.exports = {
  sendDailyWhatsAppReport,
  normalizePhoneNumber,
};
