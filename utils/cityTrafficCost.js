const pool = require("../config/db");
const logger = require("./logger");
const { s3, PutObjectCommand } = require("../config/awsConfig");
const fs = require("fs");
const path = require("path");

const rawLogFilePath = (dateKey) => path.join(__dirname, "..", "logs", `city-traffic-raw-${dateKey}.log`);
const cityNamesCache = new Map();
const trackInBackground = (promise, label) => {
  Promise.resolve(promise).catch((error) => {
    logger.warn(`[CityTrafficCost] ${label} failed: ${error.message || error}`);
  });
};
const getCityName = async (cityId) => {
  if (cityNamesCache.has(cityId)) return cityNamesCache.get(cityId);
  try {
    const { rows } = await pool.query('SELECT city_name FROM cities WHERE city_id = $1 LIMIT 1', [cityId]);
    if (rows[0]) {
      cityNamesCache.set(cityId, rows[0].city_name);
      return rows[0].city_name;
    }
  } catch (e) { }
  return `City_${cityId}`;
};

const CITY_COST_BUCKET =
  process.env.AWS_CITY_COST_S3_BUCKET ||
  process.env.AWS_LOGS_S3_BUCKET ||
  process.env.AWS_S3_BUCKET ||
  process.env.S3_BUCKET_NAME ||
  "";
const CITY_COST_PREFIX = (
  process.env.AWS_CITY_COST_S3_PREFIX || "city-cost/daily"
).replace(/^\/+|\/+$/g, "");

const ALLOWED_SOURCES = [
  "group_attendance",
  "individual_attendance",
  "professional_punch_in",
  "professional_punch_out",
  "professional_access_request",
  "face_enrollment",
];

let schemaEnsured = false;

const getIstDateKey = (value = new Date()) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

const ensureCityTrafficSchema = async () => {
  schemaEnsured = true;
};

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const normalizeMetricEntries = (entries = []) => {
  const merged = new Map();

  for (const entry of entries) {
    const cityId = Number(entry?.cityId);
    if (!Number.isInteger(cityId) || cityId <= 0) continue;

    const current = merged.get(cityId) || {
      cityId,
      requestCount: 0,
      attendanceCount: 0,
      successCount: 0,
      failureCount: 0,
    };
    current.requestCount += toPositiveInteger(entry?.requestCount);
    current.attendanceCount += toPositiveInteger(entry?.attendanceCount);
    current.successCount += toPositiveInteger(entry?.successCount);
    current.failureCount += toPositiveInteger(entry?.failureCount);
    merged.set(cityId, current);
  }

  return Array.from(merged.values()).filter(
    (entry) =>
      entry.requestCount > 0 ||
      entry.attendanceCount > 0 ||
      entry.successCount > 0 ||
      entry.failureCount > 0
  );
};

const getRequestCityIdFromWard = async (wardId) => {
  const parsedWardId = Number(wardId);
  if (!Number.isInteger(parsedWardId) || parsedWardId <= 0) return null;

  const { rows } = await pool.query(
    `SELECT z.city_id
     FROM wards w
     JOIN zones z ON z.zone_id = w.zone_id
     WHERE w.ward_id = $1
     LIMIT 1`,
    [parsedWardId]
  );

  return rows[0]?.city_id ? Number(rows[0].city_id) : null;
};

const getCityIdForEmployee = async (employeeId) => {
  const parsedEmployeeId = Number(employeeId);
  if (!Number.isInteger(parsedEmployeeId) || parsedEmployeeId <= 0) return null;

  const { rows } = await pool.query(
    `SELECT z.city_id
     FROM employee e
     JOIN wards w ON w.ward_id = e.ward_id
     JOIN zones z ON z.zone_id = w.zone_id
     WHERE e.emp_id = $1
     LIMIT 1`,
    [parsedEmployeeId]
  );

  return rows[0]?.city_id ? Number(rows[0].city_id) : null;
};

const resolveRequestCityId = async ({ wardId, supervisorId, employeeId } = {}) => {
  if (wardId) {
    const cityId = await getRequestCityIdFromWard(wardId);
    if (cityId) return cityId;
  }

  if (employeeId) {
    const cityId = await getCityIdForEmployee(employeeId);
    if (cityId) return cityId;
  }

  if (supervisorId) {
    const parsedSupId = Number(supervisorId);
    if (Number.isInteger(parsedSupId) && parsedSupId > 0) {
      const { rows } = await pool.query(
        `SELECT z.city_id
         FROM (
           SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1
           UNION
           SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
         ) sw
         JOIN wards w ON w.ward_id = sw.ward_id
         JOIN zones z ON z.zone_id = w.zone_id
         LIMIT 1`,
        [parsedSupId]
      );
      if (rows[0]?.city_id) return Number(rows[0].city_id);
    }
  }

  try {
    const { rows } = await pool.query(
      `SELECT city_id FROM city_billing_configs ORDER BY city_id ASC LIMIT 1`
    );
    if (rows[0]?.city_id) return Number(rows[0].city_id);
  } catch (e) {
    // Ignore error
  }

  return null;
};


const getEmployeeCityBreakdown = async (employeeIds = []) => {
  const normalizedEmployeeIds = employeeIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (!normalizedEmployeeIds.length) return [];

  const { rows } = await pool.query(
    `SELECT z.city_id, COUNT(*)::int AS attendance_count
     FROM employee e
     JOIN wards w ON w.ward_id = e.ward_id
     JOIN zones z ON z.zone_id = w.zone_id
     WHERE e.emp_id = ANY($1::int[])
     GROUP BY z.city_id`,
    [normalizedEmployeeIds]
  );

  return rows.map((row) => ({
    cityId: Number(row.city_id),
    requestCount: 0,
    attendanceCount: Number(row.attendance_count) || 0,
    successCount: 0,
    failureCount: 0,
  }));
};

const getDailySummaryRows = async (metricDate) => {
  const { rows } = await pool.query(
    `SELECT
       d.metric_date::text AS metric_date,
       d.city_id,
       c.city_name,
       d.source,
       COALESCE(cfg.partner_name, '') AS partner_name,
       COALESCE(cfg.billing_model, 'per_attendance') AS billing_model,
       COALESCE(cfg.rate_per_request_inr, 0)::numeric(12,2) AS rate_per_request_inr,
       COALESCE(cfg.rate_per_attendance_inr, 0)::numeric(12,2) AS rate_per_attendance_inr,
       SUM(d.request_count)::int AS request_count,
       SUM(d.attendance_count)::int AS attendance_count,
       SUM(d.success_count)::int AS success_count,
       SUM(d.failure_count)::int AS failure_count,
       ROUND(
         SUM(
           (d.request_count * COALESCE(cfg.rate_per_request_inr, 0)) +
           (d.attendance_count * COALESCE(cfg.rate_per_attendance_inr, 0))
         )::numeric,
         2
       ) AS total_cost_inr,
       MAX(d.snapshot_s3_key) AS snapshot_s3_key
     FROM city_daily_traffic_cost d
     JOIN cities c ON c.city_id = d.city_id
     LEFT JOIN city_billing_configs cfg ON cfg.city_id = d.city_id
     WHERE d.metric_date = $1::date
     GROUP BY
       d.metric_date,
       d.city_id,
       c.city_name,
       d.source,
       cfg.partner_name,
       cfg.billing_model,
       cfg.rate_per_request_inr,
       cfg.rate_per_attendance_inr
     ORDER BY c.city_name ASC, d.source ASC`,
    [metricDate]
  );

  return rows;
};

const syncDailySnapshotToS3 = async (metricDate) => {
  if (!CITY_COST_BUCKET) return null;

  const rows = await getDailySummaryRows(metricDate);
  const key = `${CITY_COST_PREFIX}/${metricDate}.json`;
  const body = JSON.stringify(
    {
      metricDate,
      generatedAt: new Date().toISOString(),
      currency: "INR",
      rows,
    },
    null,
    2
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: CITY_COST_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    })
  );

  const rawLogPath = rawLogFilePath(metricDate);
  if (fs.existsSync(rawLogPath)) {
    try {
      const rawLogContent = fs.readFileSync(rawLogPath);
      const rawKey = `${CITY_COST_PREFIX}/raw-logs/${metricDate}.log`;
      await s3.send(
        new PutObjectCommand({
          Bucket: CITY_COST_BUCKET,
          Key: rawKey,
          Body: rawLogContent,
          ContentType: "text/plain",
        })
      );
    } catch (rawErr) {
      logger.error(`[CityTrafficCost] Failed to sync raw logs to S3: ${rawErr.message}`);
    }
  }

  await pool.query(
    `UPDATE city_daily_traffic_cost
     SET snapshot_s3_key = $2,
         updated_at = NOW()
     WHERE metric_date = $1::date`,
    [metricDate, key]
  );

  return key;
};

let trafficBuffer = {};
let flushTimeout = null;
const s3SyncTimers = {};

const flushTrafficBuffer = async () => {
  flushTimeout = null;
  const currentBuffer = trafficBuffer;
  trafficBuffer = {};

  const keys = Object.keys(currentBuffer);
  if (!keys.length) return;

  try {
    await ensureCityTrafficSchema();

    const values = [];
    const valuePlaceholders = [];
    let index = 1;

    for (const key of keys) {
      const entry = currentBuffer[key];
      values.push(
        entry.metricDate,
        entry.cityId,
        entry.source,
        entry.requestCount,
        entry.attendanceCount,
        entry.successCount,
        entry.failureCount
      );
      valuePlaceholders.push(
        `($${index}::date, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, $${index + 6})`
      );
      index += 7;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const key of keys) {
        const entry = currentBuffer[key];
        const updateResult = await client.query(
          `UPDATE city_daily_traffic_cost
           SET request_count = request_count + $4,
               attendance_count = attendance_count + $5,
               success_count = success_count + $6,
               failure_count = failure_count + $7,
               updated_at = NOW()
           WHERE metric_date = $1::date
             AND city_id = $2
             AND source = $3`,
          [
            entry.metricDate,
            entry.cityId,
            entry.source,
            entry.requestCount,
            entry.attendanceCount,
            entry.successCount,
            entry.failureCount,
          ]
        );

        if (!updateResult.rowCount) {
          await client.query(
            `INSERT INTO city_daily_traffic_cost (
               metric_date,
               city_id,
               source,
               request_count,
               attendance_count,
               success_count,
               failure_count,
               created_at,
               updated_at
             )
             VALUES ($1::date, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            [
              entry.metricDate,
              entry.cityId,
              entry.source,
              entry.requestCount,
              entry.attendanceCount,
              entry.successCount,
              entry.failureCount,
            ]
          );
        }
      }

      await client.query("COMMIT");
    } catch (writeError) {
      await client.query("ROLLBACK");
      throw writeError;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error(`[CityTrafficCost] Failed to flush traffic buffer: ${error.message}`);
  }
};

const scheduleBufferFlush = () => {
  if (flushTimeout) return;
  flushTimeout = setTimeout(flushTrafficBuffer, 5000);
};

process.on("beforeExit", () => {
  flushTrafficBuffer().catch((err) =>
    logger.error(`[CityTrafficCost] Process exit flush failed: ${err.message}`)
  );
});

const handleShutdown = async (signal) => {
  logger.info(`[CityTrafficCost] Received ${signal}, flushing traffic buffer...`);
  try {
    await flushTrafficBuffer();
  } catch (err) {
    logger.error(`[CityTrafficCost] Shutdown flush failed: ${err.message}`);
  }
  process.exit(0);
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

process.once("SIGUSR2", async () => {
  logger.info("[CityTrafficCost] Received SIGUSR2, flushing traffic buffer...");
  try {
    await flushTrafficBuffer();
  } catch (err) {
    logger.error(`[CityTrafficCost] SIGUSR2 flush failed: ${err.message}`);
  }
  process.kill(process.pid, "SIGUSR2");
});

const debounceSyncDailySnapshotToS3 = (metricDate) => {
  if (s3SyncTimers[metricDate]) {
    return;
  }
  s3SyncTimers[metricDate] = setTimeout(async () => {
    delete s3SyncTimers[metricDate];
    try {
      await syncDailySnapshotToS3(metricDate);
    } catch (err) {
      logger.warn(
        `[CityTrafficCost] Debounced snapshot sync failed for ${metricDate}: ${err.message}`
      );
    }
  }, 60000);
};

const trackCityTraffic = async ({
  source,
  metricDate = getIstDateKey(),
  entries = [],
  syncSnapshot = true,
}) => {
  if (!source || !ALLOWED_SOURCES.includes(source)) return;

  const normalizedEntries = normalizeMetricEntries(entries);
  if (!normalizedEntries.length) return;

  for (const entry of normalizedEntries) {
    const key = `${metricDate}:${entry.cityId}:${source}`;
    if (!trafficBuffer[key]) {
      trafficBuffer[key] = {
        metricDate,
        cityId: entry.cityId,
        source,
        requestCount: 0,
        attendanceCount: 0,
        successCount: 0,
        failureCount: 0,
      };
    }
    trafficBuffer[key].requestCount += entry.requestCount;
    trafficBuffer[key].attendanceCount += entry.attendanceCount;
    trafficBuffer[key].successCount += entry.successCount;
    trafficBuffer[key].failureCount += entry.failureCount;

    // Log raw individual event
    getCityName(entry.cityId).then((cityName) => {
      const ts = new Date().toISOString();
      const sourceLabel = String(source).replace(/_/g, ' ');
      const logLine = `[${ts}] ${sourceLabel} in ${cityName} - Requests: ${entry.requestCount}, Attendance: ${entry.attendanceCount}\n`;
      try {
        const logPath = rawLogFilePath(metricDate);
        const dirPath = path.dirname(logPath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.appendFile(logPath, logLine, (appendErr) => {
          if (appendErr) {
            logger.error("Failed to append raw traffic log", appendErr);
          }
        });
      } catch (e) {
        logger.error("Failed to append raw traffic log", e);
      }
    });
  }

  scheduleBufferFlush();

  if (syncSnapshot) {
    debounceSyncDailySnapshotToS3(metricDate);
  }
};

const trackRekognitionUsage = async ({
  cityId,
  source,
  metricDate = getIstDateKey(),
  success,
}) => {
  const normalizedCityId = Number(cityId);
  if (!Number.isInteger(normalizedCityId) || normalizedCityId <= 0) return;

  await trackCityTraffic({
    source,
    metricDate,
    syncSnapshot: false,
    entries: [
      {
        cityId: normalizedCityId,
        requestCount: 1,
        attendanceCount: 0,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
      },
    ],
  });
};

const sendTrackedRekognition = async ({
  client,
  command,
  cityId,
  source,
  metricDate = getIstDateKey(),
}) => {
  try {
    const response = await client.send(command);
    trackInBackground(trackRekognitionUsage({
      cityId,
      source,
      metricDate,
      success: true,
    }), `rekognition success tracking for ${source}`);
    return response;
  } catch (error) {
    trackInBackground(trackRekognitionUsage({
      cityId,
      source,
      metricDate,
      success: false,
    }), `rekognition failure tracking for ${source}`);
    throw error;
  }
};

const trackSuccessfulAttendanceEvent = ({
  cityId,
  source,
  metricDate = getIstDateKey(),
  attendanceCount = 1,
  syncSnapshot = true,
}) => {
  const normalizedCityId = Number(cityId);
  const normalizedAttendanceCount = toPositiveInteger(attendanceCount);

  if (!Number.isInteger(normalizedCityId) || normalizedCityId <= 0) return;
  if (!normalizedAttendanceCount) return;

  trackInBackground(
    trackCityTraffic({
      source,
      metricDate,
      syncSnapshot,
      entries: [
        {
          cityId: normalizedCityId,
          requestCount: 0,
          attendanceCount: normalizedAttendanceCount,
          successCount: 0,
          failureCount: 0,
        },
      ],
    }),
    'successful attendance tracking for ' + source
  );
};

const getCityBillingConfigs = async () => {
  await ensureCityTrafficSchema();

  const { rows } = await pool.query(
    `SELECT
       c.city_id,
       c.city_name,
       COALESCE(cfg.partner_name, '') AS partner_name,
       COALESCE(cfg.billing_model, 'per_attendance') AS billing_model,
       COALESCE(cfg.rate_per_request_inr, 0)::numeric(12,2) AS rate_per_request_inr,
       COALESCE(cfg.rate_per_attendance_inr, 0)::numeric(12,2) AS rate_per_attendance_inr,
       COALESCE(cfg.notes, '') AS notes,
       cfg.updated_at,
       cfg.updated_by
     FROM cities c
     LEFT JOIN city_billing_configs cfg ON cfg.city_id = c.city_id
     ORDER BY c.city_name ASC`
  );

  return rows;
};

const upsertCityBillingConfig = async ({
  cityId,
  partnerName,
  billingModel,
  ratePerRequestInr,
  ratePerAttendanceInr,
  notes,
  updatedBy,
}) => {
  await ensureCityTrafficSchema();

  const normalizedCityId = Number(cityId);
  if (!Number.isInteger(normalizedCityId) || normalizedCityId <= 0) {
    throw new Error("Valid cityId is required.");
  }

  const normalizedModel = ["per_request", "per_attendance", "hybrid"].includes(
    billingModel
  )
    ? billingModel
    : "per_attendance";

  const { rows } = await pool.query(
    `INSERT INTO city_billing_configs (
       city_id,
       partner_name,
       billing_model,
       rate_per_request_inr,
       rate_per_attendance_inr,
       notes,
       updated_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (city_id)
     DO UPDATE SET
       partner_name = EXCLUDED.partner_name,
       billing_model = EXCLUDED.billing_model,
       rate_per_request_inr = EXCLUDED.rate_per_request_inr,
       rate_per_attendance_inr = EXCLUDED.rate_per_attendance_inr,
       notes = EXCLUDED.notes,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      normalizedCityId,
      String(partnerName || "").trim(),
      normalizedModel,
      Number(ratePerRequestInr) || 0,
      Number(ratePerAttendanceInr) || 0,
      notes ? String(notes).trim() : "",
      updatedBy ? Number(updatedBy) : null,
    ]
  );

  return rows[0];
};

const getCityTrafficSummary = async ({ fromDate, toDate }) => {
  await ensureCityTrafficSchema();

  const parseSafeDate = (val) => {
    if (!val || val === "null" || val === "undefined" || val === "") return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return val;
  };

  const startDate = parseSafeDate(fromDate) || getIstDateKey();
  const endDate = parseSafeDate(toDate) || startDate;

  const { rows } = await pool.query(
    `SELECT
       d.metric_date::text AS metric_date,
       d.city_id,
       c.city_name,
       d.source,
       COALESCE(cfg.partner_name, '') AS partner_name,
       COALESCE(cfg.billing_model, 'per_attendance') AS billing_model,
       COALESCE(cfg.rate_per_request_inr, 0)::numeric(12,2) AS rate_per_request_inr,
       COALESCE(cfg.rate_per_attendance_inr, 0)::numeric(12,2) AS rate_per_attendance_inr,
       SUM(d.request_count)::int AS request_count,
       SUM(d.attendance_count)::int AS attendance_count,
       SUM(d.success_count)::int AS success_count,
       SUM(d.failure_count)::int AS failure_count,
       ROUND(
         SUM(
           (d.request_count * COALESCE(cfg.rate_per_request_inr, 0)) +
           (d.attendance_count * COALESCE(cfg.rate_per_attendance_inr, 0))
         )::numeric,
         2
       ) AS total_cost_inr,
       MAX(d.snapshot_s3_key) AS snapshot_s3_key,
       MAX(d.updated_at) AS last_updated
     FROM city_daily_traffic_cost d
     JOIN cities c ON c.city_id = d.city_id
     LEFT JOIN city_billing_configs cfg ON cfg.city_id = d.city_id
     WHERE d.metric_date BETWEEN $1::date AND $2::date
     GROUP BY
       d.metric_date,
       d.city_id,
       c.city_name,
       d.source,
       cfg.partner_name,
       cfg.billing_model,
       cfg.rate_per_request_inr,
       cfg.rate_per_attendance_inr
     ORDER BY MAX(d.updated_at) DESC, c.city_name ASC, d.source ASC`,
    [startDate, endDate]
  );

  const cityTotalsMap = new Map();
  const dayTotalsMap = new Map();

  for (const row of rows) {
    const cityKey = String(row.city_id);
    const dayKey = String(row.metric_date).slice(0, 10);
    const rowRequestCount = Number(row.request_count) || 0;
    const rowAttendanceCount = Number(row.attendance_count) || 0;
    const rowSuccessCount = Number(row.success_count) || 0;
    const rowFailureCount = Number(row.failure_count) || 0;
    const rowCost = Number(row.total_cost_inr) || 0;

    if (!cityTotalsMap.has(cityKey)) {
      cityTotalsMap.set(cityKey, {
        city_id: row.city_id,
        city_name: row.city_name,
        partner_name: row.partner_name,
        billing_model: row.billing_model,
        rate_per_request_inr: row.rate_per_request_inr,
        rate_per_attendance_inr: row.rate_per_attendance_inr,
        request_count: 0,
        attendance_count: 0,
        success_count: 0,
        failure_count: 0,
        total_cost_inr: 0,
        latest_snapshot_s3_key: row.snapshot_s3_key || null,
      });
    }

    const cityTotal = cityTotalsMap.get(cityKey);
    cityTotal.request_count += rowRequestCount;
    cityTotal.attendance_count += rowAttendanceCount;
    cityTotal.success_count += rowSuccessCount;
    cityTotal.failure_count += rowFailureCount;
    cityTotal.total_cost_inr =
      Math.round((cityTotal.total_cost_inr + rowCost) * 100) / 100;
    cityTotal.latest_snapshot_s3_key =
      cityTotal.latest_snapshot_s3_key || row.snapshot_s3_key || null;

    if (!dayTotalsMap.has(dayKey)) {
      dayTotalsMap.set(dayKey, {
        metric_date: dayKey,
        request_count: 0,
        attendance_count: 0,
        success_count: 0,
        failure_count: 0,
        total_cost_inr: 0,
      });
    }

    const dayTotal = dayTotalsMap.get(dayKey);
    dayTotal.request_count += rowRequestCount;
    dayTotal.attendance_count += rowAttendanceCount;
    dayTotal.success_count += rowSuccessCount;
    dayTotal.failure_count += rowFailureCount;
    dayTotal.total_cost_inr =
      Math.round((dayTotal.total_cost_inr + rowCost) * 100) / 100;
  }

  const overview = Array.from(cityTotalsMap.values()).reduce(
    (acc, row) => {
      acc.request_count += row.request_count;
      acc.attendance_count += row.attendance_count;
      acc.success_count += row.success_count;
      acc.failure_count += row.failure_count;
      acc.total_cost_inr =
        Math.round((acc.total_cost_inr + Number(row.total_cost_inr || 0)) * 100) /
        100;
      return acc;
    },
    { request_count: 0, attendance_count: 0, success_count: 0, failure_count: 0, total_cost_inr: 0 }
  );

  return {
    fromDate: startDate,
    toDate: endDate,
    currency: "INR",
    bucket: CITY_COST_BUCKET || null,
    rows,
    cityTotals: Array.from(cityTotalsMap.values()).sort((a, b) =>
      String(a.city_name).localeCompare(String(b.city_name))
    ),
    dayTotals: Array.from(dayTotalsMap.values()).sort((a, b) =>
      String(b.metric_date).localeCompare(String(a.metric_date))
    ),
    overview,
  };
};

module.exports = {
  ensureCityTrafficSchema,
  getCityBillingConfigs,
  getCityIdForEmployee,
  getCityTrafficSummary,
  getEmployeeCityBreakdown,
  getRequestCityIdFromWard,
  getIstDateKey,
  resolveRequestCityId,
  sendTrackedRekognition,
  syncDailySnapshotToS3,
  trackCityTraffic,
  trackRekognitionUsage,
  trackSuccessfulAttendanceEvent,
  upsertCityBillingConfig,
};
