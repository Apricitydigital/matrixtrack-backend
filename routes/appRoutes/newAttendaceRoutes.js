// router.post("/self/punch", authenticate, upload.single("image"), async (req, res) => {
//     try {
//         await ensureSelfAttendanceSupport();
//         const resolved = await resolveEmployeeForUser(req.user);
//         if (!resolved) {
//             return res
//                 .status(404)
//                 .json({ error: "Employee profile not found for this user" });
//         }

//         if (!resolved.employee.self_attendance_enabled) {
//             return res
//                 .status(403)
//                 .json({ error: "Self punch is not enabled for this employee" });
//         }

//         if (!resolved.employee.face_embedding) {
//             return res.status(412).json({
//                 error: "Store the employee face before marking self attendance",
//             });
//         }

//         if (!req.file) {
//             return res.status(400).json({ error: "Face image is required" });
//         }

//         await ensureNormalizedCaptureFile(req.file);

//         const normalizedPunchType = (req.body?.punch_type || "")
//             .toString()
//             .trim()
//             .toUpperCase();
//         const punchType =
//             normalizedPunchType === PUNCH_TYPES.OUT
//                 ? PUNCH_TYPES.OUT
//                 : PUNCH_TYPES.IN;

//         const attendanceDate = resolveAttendanceDate(req.body, req.query);

//         // ?? Session-aware validation (prevents re-punch-in + night shift support)
//         const sessionError = await validatePunchSession(resolved.employee.emp_id, attendanceDate, punchType);
//         if (sessionError) {
//             return res.status(sessionError.status).json({
//                 error: sessionError.error,
//                 code: sessionError.code,
//             });
//         }

//         // Resolve or create attendance record (handles night-shift carry-forward)
//         const attendance = await getOrCreateAttendanceRecord(
//             resolved.employee.emp_id,
//             attendanceDate,
//             { punchType, createIfMissing: true }
//         );

//         // ?? Geofencing Validation
//         const geoCheck = await validateGeofencing(
//             resolved.employee.emp_id,
//             req.body.latitude,
//             req.body.longitude
//         );
//         if (!geoCheck.allowed) {
//             if (geoCheck.notConfigured) {
//                 return res.status(403).json({
//                     error: "Your geofencing location is not mapped yet",
//                     notConfigured: true,
//                     details:
//                         geoCheck.message ||
//                         "Please contact admin to configure your zone boundaries.",
//                 });
//             }
//             return res.status(403).json({
//                 error: "Out of Zone",
//                 notConfigured: false,
//                 details:
//                     geoCheck.message || "You are outside the allowed geo-fence zone.",
//             });
//         }

//         const updated = await processPunch(
//             attendance.attendance_id,
//             punchType,
//             req.file,
//             req.user?.user_id,
//             {
//                 latitude: req.body.latitude ?? "0",
//                 longitude: req.body.longitude ?? "0",
//                 address: req.body.address ?? "",
//             },
//             {
//                 employeeId: resolved.employee.emp_id,
//                 requireFaceMatch: true,
//             }
//         );

//         res.json({
//             success: true,
//             attendance_id: attendance.attendance_id,
//             punch_type: punchType,
//             face_similarity: updated.face_similarity ?? null,
//             face_match_threshold: updated.face_match_threshold ?? null,
//             time:
//                 punchType === PUNCH_TYPES.IN
//                     ? updated.punch_in_time
//                     : updated.punch_out_time,
//         });
//     } catch (error) {
//         console.error("Self punch error:", error);
//         if (error.statusCode) {
//             return res
//                 .status(error.statusCode)
//                 .json({ error: error.message, details: error.details });
//         }
//         res.status(500).json({ error: "Unable to process self punch" });
//     }
// });


//Full working code for reference

const express = require("express");
const axios = require("axios");
const router = express.Router();
const pool = require("../../config/db");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  uploadAttendanceImage,
  isLocalImage,
  getLocalImagePath,
  isS3Image,
  extractS3Key,
  getS3ImageStream,
} = require("../../utils/s3Storage");
const {
  hasBackblazeCredentials,
  isBackblazeUrl,
  parseBackblazeUrl,
  fetchBackblazeStream,
} = require("../../utils/backblaze");
const {
  buildAttendanceImagePath,
  getAttendanceUploadContext,
} = require("../../utils/attendanceKeyBuilder");

const {
  s3,
  rekognition,
  CreateCollectionCommand,
  CompareFacesCommand,
  SearchFacesByImageCommand,
  DetectFacesCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  IndexFacesCommand,
} = require("../../config/awsConfig");
const authenticate = require("../../middleware/authMiddleware");
const {
  ensureSelfAttendanceSupport,
  fetchEmployeeByCode,
  fetchEmployeeById,
} = require("../../utils/selfAttendance");
const { buildPublicFaceUrl } = require("../../utils/faceImage");
const { validateGeofencing } = require("../../utils/geofencing");
const {
  sendTrackedRekognition,
  resolveRequestCityId,
  trackSuccessfulAttendanceEvent,
} = require("../../utils/cityTrafficCost");

const sendTrackedAttendanceRekognition = async (command, trackingPayload) => {
  return sendTrackedRekognition({
    client: rekognition,
    command,
    cityId: trackingPayload?.cityId,
    source: trackingPayload?.source,
    metricDate: trackingPayload?.metricDate,
  });
};

const safeDebugLog = (line) => {
  try {
    fs.appendFile("debug-face.log", `${line}\n`, () => {});
  } catch (_) {
    // Never block attendance flow for debug logging failures.
  }
};

ensureSelfAttendanceSupport().catch((error) => {
  console.warn(
    "Self attendance bootstrap skipped:",
    error?.message || error
  );
});

// Constants
const PUNCH_TYPES = {
  IN: "IN",
  MID_IN: "MID_IN",
  OUT: "OUT",
};

const normalizePunchType = (value) => {
  const normalized = (value || "").toString().trim().toUpperCase();
  if (normalized === PUNCH_TYPES.OUT) return PUNCH_TYPES.OUT;
  if (["MID_IN", "MID", "MIDSHIFT", "MID_SHIFT"].includes(normalized)) {
    return PUNCH_TYPES.MID_IN;
  }
  return PUNCH_TYPES.IN;
};

const resolvePunchRecordTime = (record, punchType) => {
  if (punchType === PUNCH_TYPES.OUT) return record?.punch_out_time ?? null;
  if (punchType === PUNCH_TYPES.MID_IN) return record?.mid_shift_punch_in_time ?? null;
  return record?.punch_in_time ?? null;
};

const DEFAULT_ATTENDANCE_TIMEZONE =
  process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";
const parsedRolloverHour =
  Number(
    process.env.NIGHT_SHIFT_ROLLOVER_HOUR ??
    process.env.ATTENDANCE_ROLLOVER_HOUR ??
    4
  ) || 4;
const NIGHT_SHIFT_ROLLOVER_HOUR =
  Number.isFinite(parsedRolloverHour) &&
    parsedRolloverHour >= 0 &&
    parsedRolloverHour <= 23
    ? parsedRolloverHour
    : 4;

const DATE_INPUT_KEYS = ["date", "attendance_date", "punch_date"];
const TIMESTAMP_INPUT_KEYS = [
  "timestamp",
  "client_timestamp",
  "clientTime",
  "captured_at",
];

const ALLOWED_LEAVE_TYPES = new Set([
  "ABSENT",
  "LOP",
  "EL",
  "SLML",
  "CL",
  "COMP_OFF",
  "OUT_DUTY",
  "WEEKLY_OFF",
  "CASUAL",
  "MEDICAL",
]);

const normalizeLeaveInput = (value) =>
  String(value || "")
    .trim()
    .replace(/[\/\s-]+/g, "_")
    .toUpperCase();

const resolveIsoDateInput = (input) => {
  if (!input) {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: DEFAULT_ATTENDANCE_TIMEZONE,
    });
  }

  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
    return input.trim();
  }

  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("en-CA", {
      timeZone: DEFAULT_ATTENDANCE_TIMEZONE,
    });
  }

  return new Date().toLocaleDateString("en-CA", {
    timeZone: DEFAULT_ATTENDANCE_TIMEZONE,
  });
};

const attendanceDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_ATTENDANCE_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const escapedAttendanceTimeZone = DEFAULT_ATTENDANCE_TIMEZONE.replace(/'/g, "''");

const formatPunchTimeForClient = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString("en-IN", {
    timeZone: DEFAULT_ATTENDANCE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

// Set up Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit to prevent memory exhaustion while allowing high-res photos
});

// Utility helpers
const resolveCollectionId = () => {
  const id =
    (process.env.REKOGNITION_COLLECTION || "").trim() ||
    (process.env.REKOGNITION_COLLECTION_ID || "").trim();
  return id || null;
};

let faceCollectionReady = false;

const ensureCollectionExists = async (collectionId) => {
  if (faceCollectionReady) {
    return;
  }

  try {
    await rekognition.send(
      new CreateCollectionCommand({
        CollectionId: collectionId,
      })
    );
    console.log(`Created Rekognition collection "${collectionId}".`);
  } catch (error) {
    if (error.name !== "ResourceAlreadyExistsException") {
      throw error;
    }
  }

  faceCollectionReady = true;
};

const normalizeId = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveMonthRange = (rawMonth) => {
  const now = new Date();
  const fallbackYear = now.getFullYear();
  const fallbackMonth = now.getMonth() + 1;

  const normalized = (rawMonth || "").toString().trim();
  let year = fallbackYear;
  let month = fallbackMonth;

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(normalized);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);

  if (monthMatch) {
    year = Number(monthMatch[1]);
    month = Number(monthMatch[2]);
  } else if (dateMatch) {
    year = Number(dateMatch[1]);
    month = Number(dateMatch[2]);
  }

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    year = fallbackYear;
    month = fallbackMonth;
  }

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;

  return { startDate, endDate, month: monthKey };
};

const ensureEmployeeRole = async () => {
  const { rows } = await pool.query(
    `
      INSERT INTO roles (name, description, is_system)
      VALUES ('employee', 'Employee self-attendance role', TRUE)
      ON CONFLICT (name)
      DO UPDATE SET description = EXCLUDED.description
      RETURNING id
    `
  );

  return rows[0]?.id || null;
};

async function resolveEmployeeForUser(userPayload) {
  const userId = normalizeId(userPayload?.user_id ?? userPayload?.id);
  if (!userId) {
    return null;
  }

  const { rows } = await pool.query(
    `
      SELECT user_id, emp_code, role, email, name, phone
        FROM users
       WHERE user_id = $1
       LIMIT 1
    `,
    [userId]
  );

  if (!rows.length) {
    return null;
  }

  const user = rows[0];
  const employee = await fetchEmployeeByCode(user.emp_code);
  if (!employee) {
    return null;
  }

  return { user, employee };
}

const GROUP_MODE_KEYWORDS = new Set([
  "group",
  "groups",
  "groupattendance",
  "groupmode",
  "bulk",
  "multi",
  "multiple",
  "multiface",
  "multifaces",
  "multifacemode",
]);

const isGroupModeRequest = (...rawValues) => {
  return rawValues.some((value) => {
    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value === "boolean") {
      return value;
    }

    const normalized = value.toString().trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (normalized === "1" || normalized === "true" || normalized === "yes") {
      return true;
    }

    const condensed = normalized.replace(/[^a-z]/g, "");
    return GROUP_MODE_KEYWORDS.has(condensed);
  });
};

const computeCropRegion = (boundingBox, imageWidth, imageHeight, paddingRatio = 0.25) => {
  if (
    !boundingBox ||
    typeof imageWidth !== "number" ||
    typeof imageHeight !== "number" ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null;
  }

  const baseWidth = Math.max(Math.round(boundingBox.Width * imageWidth), 1);
  const baseHeight = Math.max(Math.round(boundingBox.Height * imageHeight), 1);
  const padX = Math.round(baseWidth * paddingRatio);
  const padY = Math.round(baseHeight * paddingRatio);

  const left = Math.max(Math.round(boundingBox.Left * imageWidth) - padX, 0);
  const top = Math.max(Math.round(boundingBox.Top * imageHeight) - padY, 0);

  const width = Math.min(imageWidth - left, baseWidth + padX * 2);
  const height = Math.min(imageHeight - top, baseHeight + padY * 2);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { left, top, width, height };
};

async function normalizeCaptureBuffer(buffer) {
  if (!buffer) {
    return buffer;
  }
  try {
    return await sharp(buffer).rotate().toBuffer();
  } catch (error) {
    console.warn("normalizeCaptureBuffer: unable to rotate image", error.message || error);
    return buffer;
  }
}

async function ensureNormalizedCaptureFile(file) {
  if (!file || !file.buffer || file.__normalized) {
    return file;
  }
  file.buffer = await normalizeCaptureBuffer(file.buffer);
  file.__normalized = true;
  return file;
}

async function resolveEmployeeFromFaceIdentifiers({
  faceId = null,
  matchedExternalId = null,
  requestedEmpId = null,
}) {
  const normalizeText = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    const text = String(value).trim();
    return text || null;
  };

  const tryResolveByEmpIdOnly = async (empIdStr) => {
    const normalized = normalizeText(empIdStr);
    if (!normalized) return null;
    const numericEmpId = normalizeId(normalized);
    if (numericEmpId === null) return null;
    const { rows } = await pool.query(
      `SELECT emp_id, emp_code, name, face_embedding FROM employee WHERE emp_id = $1 LIMIT 1`,
      [numericEmpId]
    );
    return rows.length ? rows[0] : null;
  };

  const tryResolveByIdentifier = async (identifier) => {
    const normalized = normalizeText(identifier);
    if (!normalized) {
      return null;
    }

    const numericEmpId = normalizeId(normalized);
    const { rows } = await pool.query(
      `
        SELECT emp_id, emp_code, name, face_embedding
          FROM employee
         WHERE ($1::int IS NOT NULL AND emp_id = $1::int)
            OR LOWER(TRIM(emp_code)) = LOWER(TRIM($2))
         LIMIT 1
      `,
      [numericEmpId, normalized]
    );

    return rows.length ? rows[0] : null;
  };

  let employeeRecord = null;

  if (faceId) {
    const { rows } = await pool.query(
      `
        SELECT emp_id, emp_code, name, face_embedding
          FROM employee
         WHERE face_id = $1
            OR emp_id::text = $1
            OR LOWER(TRIM(emp_code)) = LOWER(TRIM($1))
         LIMIT 1
      `,
      [faceId]
    );

    if (rows.length) {
      return rows[0];
    }
  }

  if (!employeeRecord && matchedExternalId !== null) {
    employeeRecord = await tryResolveByEmpIdOnly(matchedExternalId);
  }

  if (!employeeRecord && requestedEmpId !== null) {
    employeeRecord = await tryResolveByIdentifier(requestedEmpId);
  }

  return employeeRecord;
}

// Legacy sync check � used only as last-resort guard on the attendance object itself
function validatePunchAttempt(attendance, punchType) {
  if (!attendance) {
    return {
      status: punchType === PUNCH_TYPES.OUT ? 400 : 404,
      error:
        punchType === PUNCH_TYPES.OUT
          ? "Punch in First"
          : "Attendance record not found",
    };
  }

  if (punchType === PUNCH_TYPES.IN && attendance.punch_in_time) {
    return {
      status: 400,
      error: "Aap abhi bhi punched in hain. Pehle punch out karein.",
    };
  }

  if (punchType === PUNCH_TYPES.OUT && attendance.punch_out_time) {
    return {
      status: 400,
      error: "Aap pehle se punch out kar chuke hain.",
    };
  }

  if (punchType === PUNCH_TYPES.OUT && !attendance.punch_in_time) {
    return {
      status: 400,
      error: "Punch in First",
    };
  }

  return null;
}

/**
 * ?? SESSION-AWARE PUNCH VALIDATION (Night-Shift + Re-Punch-In Guard)
 *
 * PUNCH IN allowed only if:
 *   1. No OPEN session exists (already punched in but not out)
 *   2. No CLOSED session exists for this attendance_date (already done for the day)
 *
 * PUNCH OUT allowed only if:
 *   1. An OPEN session exists
 *
 * Night shift is handled automatically:
 *   - 11 PM punch-in ? attendance_date = Day1 (formatDate uses NIGHT_SHIFT_ROLLOVER_HOUR)
 *   - 4 AM punch-out ? finds the open session from Day1, closes it correctly
 *   - Re-punch-in on Day2 morning is blocked because Day1 session is now CLOSED
 */
async function validatePunchSession(empId, attendanceDate, punchType) {
  if (!empId || !attendanceDate) {
    return { status: 400, error: "Employee ID aur date zaroori hain" };
  }

  if (punchType === PUNCH_TYPES.MID_IN) {
    // MID_IN must be evaluated only against the active/open session.
    // Do not block due to older closed sessions from previous day.
    const openSession = await fetchRecentOpenAttendance(empId, attendanceDate);
    if (!openSession || !openSession.punch_in_time) {
      return {
        status: 400,
        error: "Punch in First",
        code: "NOT_PUNCHED_IN",
      };
    }

    // Defensive guard: if somehow the resolved session is closed, MID_IN is not allowed.
    if (openSession.punch_out_time) {
      return {
        status: 400,
        error: "Mid shift punch is allowed after Punch out!!!",
        code: "ALREADY_PUNCHED_OUT",
      };
    }

    // Allow only one MID_IN per active session.
    if (openSession.mid_shift_punch_in_time) {
      return {
        status: 400,
        error: "Punch already marked",
        code: "MID_SHIFT_ALREADY_MARKED",
      };
    }
  }

  // Enforce punch-in before punch-out (with support for night-shift carry-forward)
  if (punchType === PUNCH_TYPES.OUT) {
    const hasPunchStart = await fetchRecentPunchedInAttendance(empId, attendanceDate);
    if (!hasPunchStart) {
      return {
        status: 400,
        error: "Punch in First",
        code: "NOT_PUNCHED_IN",
      };
    }
  }

  // Multi-punch allowed: we no longer block re-punch-in or re-punch-out.
  // The system will update the existing record for the day.
  return null; // ? OK to proceed
}

const mapRekognitionError = (error) => {
  const message = error?.message || "Face recognition failed";
  const lower = message.toLowerCase();

  if (lower.includes("no faces") || lower.includes("no face")) {
    return {
      status: 422,
      payload: {
        error: "No face detected in the image",
        details: message,
        suggestion: "Ensure the employee's face is centered and well lit, then retry.",
      },
    };
  }

  if (error.name === "ResourceNotFoundException") {
    return {
      status: 500,
      payload: {
        error: "Rekognition collection not found",
        details: message,
        solution:
          "Recreate the collection or verify REKOGNITION_COLLECTION in the backend .env file.",
      },
    };
  }

  return {
    status: error.$metadata?.httpStatusCode || 500,
    payload: {
      error: "Face recognition failed",
      details: message,
    },
  };
};

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
const SECONDARY_S3_BUCKET = process.env.SECONDARY_S3_BUCKET;
const BACKBLAZE_BUCKET = process.env.BACKBLAZE_BUCKET;
const parsedFaceThreshold = Number(process.env.FACE_MATCH_THRESHOLD ?? "97");
const DEFAULT_FACE_MATCH_THRESHOLD = Number.isFinite(parsedFaceThreshold)
  ? parsedFaceThreshold
  : 95;
const GROUP_FACE_SEARCH_TIMEOUT_MS = Number(
  process.env.GROUP_FACE_SEARCH_TIMEOUT_MS || 8000
);
const GROUP_DOUBLE_VERIFY_ENABLED =
  process.env.GROUP_DOUBLE_VERIFY_ENABLED === "true";
const GROUP_FALLBACK_ENABLED =
  process.env.GROUP_FALLBACK_ENABLED !== "false";

// --- COST OPTIMIZATION: Individual punch fallback loop ------------------------
// When SearchFacesByImage returns no match, fallbackMatchByCompare runs a
// CompareFaces call for EVERY employee in the ward � extremely expensive at scale.
// Default: DISABLED. Enable only for debugging via env flag.
// Set INDIVIDUAL_FALLBACK_ENABLED=true in .env ONLY if needed.
const INDIVIDUAL_FALLBACK_ENABLED =
  process.env.INDIVIDUAL_FALLBACK_ENABLED === "true";

// --- COST OPTIMIZATION: 60-second punch dedup cache --------------------------
// Prevents double-billing when supervisor retries on network timeout.
// key: `${empId}:${punchType}:${date}` ? timestamp of last successful punch.
// In-memory is sufficient: restarts clear it, and 60s window is short enough.
const recentPunchCache = new Map();
const PUNCH_DEDUP_WINDOW_MS = 60_000; // 60 seconds

/**
 * Returns true if this punch was already processed within PUNCH_DEDUP_WINDOW_MS.
 * Side-effect: records the current timestamp for new/expired entries.
 */
function isDuplicatePunch(empId, punchType, date) {
  const key = `${empId}:${punchType}:${date}`;
  const lastTs = recentPunchCache.get(key);
  const now = Date.now();
  if (lastTs && now - lastTs < PUNCH_DEDUP_WINDOW_MS) {
    return true;
  }
  recentPunchCache.set(key, now);
  // Evict old entries periodically to avoid unbounded memory growth
  if (recentPunchCache.size > 10_000) {
    const cutoff = now - PUNCH_DEDUP_WINDOW_MS * 2;
    for (const [k, ts] of recentPunchCache) {
      if (ts < cutoff) recentPunchCache.delete(k);
    }
  }
  return false;
}

const withTimeout = async (promise, timeoutMs, timeoutMessage) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(timeoutMessage || "Operation timed out");
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let currentIndex = 0;
  const workers = [];

  const worker = async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      try {
        const value = await fn(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const actualLimit = Math.min(limit, items.length);
  for (let i = 0; i < actualLimit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
};

const parseRekognitionError = (error) => {
  const name = error?.name || error?.code || "UnknownError";
  const message = error?.message || "";
  const requestId = error?.$metadata?.requestId;

  const isNoFace = name === "InvalidParameterException" && (message.includes("There are no faces in the image") || message.includes("no faces"));
  const isThrottled = name === "ProvisionedThroughputExceededException" || name === "RequestLimitExceeded" || message.includes("Rate exceeded");
  const isTimeout = name === "TIMEOUT" || message.includes("timed out");

  let reason = "unknown";
  if (isNoFace) reason = "no_face";
  else if (isThrottled) reason = "rekognition_throttled";
  else if (isTimeout) reason = "timeout";

  return { isExpected: isNoFace || isThrottled || isTimeout, reason, name, message, requestId };
};

// Utility functions
const pad2 = (value) => String(value).padStart(2, "0");

function getAttendanceDateParts(date = new Date()) {
  const parts = attendanceDateFormatter.formatToParts(
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  );

  const lookup = (type) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: lookup("year"),
    month: lookup("month"),
    day: lookup("day"),
    hour: lookup("hour"),
  };
}

function formatDate(date = new Date(), options = {}) {
  const { rolloverHour = NIGHT_SHIFT_ROLLOVER_HOUR } = options;
  const validDate =
    date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const { year, month, day, hour } = getAttendanceDateParts(validDate);

  let adjustedYear = year;
  let adjustedMonth = month;
  let adjustedDay = day;

  if (
    typeof rolloverHour === "number" &&
    rolloverHour >= 0 &&
    rolloverHour <= 23 &&
    hour < rolloverHour
  ) {
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    utcDate.setUTCDate(utcDate.getUTCDate() - 1);
    adjustedYear = utcDate.getUTCFullYear();
    adjustedMonth = utcDate.getUTCMonth() + 1;
    adjustedDay = utcDate.getUTCDate();
  }

  return `${adjustedYear}-${pad2(adjustedMonth)}-${pad2(adjustedDay)}`;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDateInput(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (ISO_DATE_PATTERN.test(trimmed)) {
      return trimmed;
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDate(parsed);
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return formatDate(new Date(numeric));
    }
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDate(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return formatDate(new Date(value));
  }

  return null;
}

function resolveAttendanceDate(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }

    for (const key of DATE_INPUT_KEYS) {
      const normalized = normalizeDateInput(source[key]);
      if (normalized) {
        return normalized;
      }
    }
  }

  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }

    for (const key of TIMESTAMP_INPUT_KEYS) {
      const normalized = normalizeDateInput(source[key]);
      if (normalized) {
        return normalized;
      }
    }
  }

  return formatDate();
}

const ATTENDANCE_SELECT_FIELDS = `
    a.attendance_id,
    CAST(a.date AS VARCHAR) AS date,
    TO_CHAR((a.punch_in_time AT TIME ZONE '${escapedAttendanceTimeZone}'), 'HH12:MI AM') AS punch_in_time,
    TO_CHAR((a.punch_out_time AT TIME ZONE '${escapedAttendanceTimeZone}'), 'HH12:MI AM') AS punch_out_time,
    a.duration,
    a.punch_in_image,
    a.punch_out_image,
    a.latitude_in,
    a.longitude_in,
    a.in_address,
    a.latitude_out,
    a.longitude_out,
    a.out_address,
    e.emp_id,
    e.emp_code,
    e.name AS employee_name,
    d.designation_name,
    w.ward_id,
    w.ward_name
`;

const ATTENDANCE_SELECT_JOINS = `
  FROM attendance a
  JOIN employee e ON a.emp_id = e.emp_id
  JOIN designation d ON e.designation_id = d.designation_id
  JOIN wards w ON e.ward_id = w.ward_id
`;

const buildAttendanceRecordQuery = (whereClause) => `
  SELECT
    ${ATTENDANCE_SELECT_FIELDS}
  ${ATTENDANCE_SELECT_JOINS}
  WHERE ${whereClause}
  ORDER BY a.date DESC, a.attendance_id DESC
  LIMIT 1
`;

async function fetchAttendanceRecord(whereClause, params) {
  const query = buildAttendanceRecordQuery(whereClause);
  const { rows } = await pool.query(query, params);
  return rows[0] || null;
}

async function fetchRecentOpenAttendance(empId, date) {
  if (!empId || !date) {
    return null;
  }

  return fetchAttendanceRecord(
    `
      a.emp_id = $1
      AND (a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL)
      AND a.punch_out_time IS NULL
      AND (
        a.date = $2::date
        OR
        (
          a.date = $2::date - INTERVAL '1 day'
          AND (a.punch_in_time AT TIME ZONE '${escapedAttendanceTimeZone}')::time >= '16:00:00'::time
        )
      )
    `,
    [empId, date]
  );
}

async function fetchRecentPunchedInAttendance(empId, date) {
  if (!empId || !date) {
    return null;
  }

  return fetchAttendanceRecord(
    `
      a.emp_id = $1
      AND (a.punch_in_time IS NOT NULL OR a.mid_shift_punch_in_time IS NOT NULL)
      AND (
        a.date = $2::date
        OR
        (
          a.date = $2::date - INTERVAL '1 day'
          AND (a.punch_in_time AT TIME ZONE '${escapedAttendanceTimeZone}')::time >= '16:00:00'::time
        )
      )
    `,
    [empId, date]
  );
}

async function fetchRecentPrimaryPunchedInAttendance(empId, date) {
  if (!empId || !date) {
    return null;
  }

  return fetchAttendanceRecord(
    `
      a.emp_id = $1
      AND a.punch_in_time IS NOT NULL
      AND (
        a.date = $2::date
        OR
        (
          a.date = $2::date - INTERVAL '1 day'
          AND (a.punch_in_time AT TIME ZONE '${escapedAttendanceTimeZone}')::time >= '16:00:00'::time
        )
      )
    `,
    [empId, date]
  );
}

// ?? Check if a CLOSED session already exists for the given attendance_date
// (handles night-shift: session started on date-1 but punch_out on date)
async function fetchClosedSessionForDate(empId, date) {
  if (!empId || !date) {
    return null;
  }

  return fetchAttendanceRecord(
    `
      a.emp_id = $1
      AND a.date >= ($2::date - INTERVAL '1 day')
      AND a.date <= $2::date
      AND a.punch_in_time IS NOT NULL
      AND a.punch_out_time IS NOT NULL
    `,
    [empId, date]
  );
}

async function getOrCreateAttendanceRecord(emp_id, date, options = {}) {
  const { punchType = null, createIfMissing = true } = options;
  const targetDate = date || formatDate();

  let attendance = await fetchAttendanceRecord(
    "a.emp_id = $1 AND a.date = $2::date",
    [emp_id, targetDate]
  );

  const needsOpenCarryForward =
    punchType === PUNCH_TYPES.OUT &&
    (!attendance || (attendance && !attendance.punch_in_time));

  if (needsOpenCarryForward) {
    const carriedRecord = await fetchRecentOpenAttendance(emp_id, targetDate);
    if (carriedRecord) {
      return carriedRecord;
    }
  }

  if (attendance) {
    return attendance;
  }

  if (!createIfMissing && punchType === PUNCH_TYPES.OUT) {
    return null;
  }

  if (!emp_id) throw new Error("Employee ID is required");

  // ? PERF FIX: Single query fetches ward_id + display fields together (was 2 separate queries)
  const empRow = await pool.query(
    `SELECT e.ward_id, e.emp_code, e.name AS employee_name,
            d.designation_name, w.ward_name
     FROM employee e
     LEFT JOIN designation d ON e.designation_id = d.designation_id
     LEFT JOIN wards w ON e.ward_id = w.ward_id
     WHERE e.emp_id = $1
     LIMIT 1`,
    [emp_id]
  );
  const empMeta = empRow.rows[0] || {};
  const ward_id = empMeta.ward_id ?? null;

  // Create new record if not exists
  const insertResult = await pool.query(
    `INSERT INTO attendance (emp_id, date, ward_id) 
     VALUES ($1, $2::date, $3) 
     ON CONFLICT (emp_id, date) DO NOTHING
     RETURNING attendance_id, date, ward_id`,
    [emp_id, targetDate, ward_id]
  );

  if (insertResult.rowCount === 0) {
    console.warn("Record exists, skipping");
  }

  const baseAttendance =
    insertResult.rows[0] ||
    (
      await pool.query(
        `SELECT attendance_id, date, ward_id FROM attendance WHERE emp_id = $1 AND date = $2::date LIMIT 1`,
        [emp_id, targetDate]
      )
    ).rows[0];

  if (!baseAttendance) {
    console.warn("Record exists, skipping");
    return null;
  }

  const newAttendance = {
    attendance_id: baseAttendance.attendance_id,
    date,
    punch_in_time: null,
    punch_out_time: null,
    duration: null,
    punch_in_image: null,
    punch_out_image: null,
    latitude_in: null,
    longitude_in: null,
    in_address: null,
    latitude_out: null,
    longitude_out: null,
    out_address: null,
    emp_id,
    emp_code: null,
    employee_name: null,
    designation_name: null,
    ward_id: baseAttendance.ward_id,
    ward_name: null,
  };

  // ? PERF FIX: Reuse empMeta fetched above � no additional JOIN query needed
  Object.assign(newAttendance, empMeta);

  return newAttendance;
}

async function processPunch(
  attendanceId,
  punchType,
  imageFile,
  userId,
  locationData,
  options = {}
) {
  const {
    employeeId: explicitEmployeeId = null,
    requireFaceMatch = false,
    faceMatchThreshold = DEFAULT_FACE_MATCH_THRESHOLD,
    uploadContext: preloadedContext = null, // ? PERF FIX: accept pre-fetched context
  } = options;

  let uploadContext = null;
  const capturedAt = new Date();
  let uploadResult = null;
  if (imageFile) {
    // ? PERF FIX: use preloaded context if available, skips 4-table JOIN DB call
    uploadContext = preloadedContext ?? await getAttendanceUploadContext(pool, attendanceId);
    const locationMeta = locationData || {};
    const punchLabel =
      punchType === PUNCH_TYPES.IN
        ? "punch-in"
        : punchType === PUNCH_TYPES.OUT
          ? "punch-out"
          : "mid-shift-punch-in";
    const attendanceImageFile =
      buildAttendanceImagePath({
        attendanceDate: uploadContext?.attendance_date,
        punchType: punchLabel,
        empCode: uploadContext?.emp_code,
        empId: uploadContext?.emp_id,
        employeeName: uploadContext?.employee_name,
        wardName: uploadContext?.ward_name,
        zoneName: uploadContext?.zone_name,
        cityName: uploadContext?.city_name,
        address: locationMeta.address,
        latitude: locationMeta.latitude,
        longitude: locationMeta.longitude,
        capturedAt,
      }) || `attendance_${attendanceId}_${punchType}.jpg`;

    uploadResult = await uploadAttendanceImage(
      imageFile.buffer,
      attendanceImageFile
    );
  }

  const imageUrl = uploadResult?.url ?? null;
  const attendanceImageKey = uploadResult?.key ?? null;

  const resolvedEmployeeId =
    explicitEmployeeId ?? (await resolveAttendanceEmployeeId(attendanceId));

  let faceMatchMeta = null;
  if (
    requireFaceMatch &&
    AWS_S3_BUCKET &&
    attendanceImageKey &&
    resolvedEmployeeId
  ) {
    try {
      faceMatchMeta = await ensureFaceMatch(
        resolvedEmployeeId,
        attendanceImageKey,
        faceMatchThreshold
      );
    } catch (error) {
      throw error;
    }
  } else if (requireFaceMatch && !attendanceImageKey) {
    const err = new Error(
      "Attendance image could not be uploaded; face verification failed"
    );
    err.statusCode = 500;
    throw err;
  }

  const punchFieldMap =
    punchType === PUNCH_TYPES.OUT
      ? {
        time: "punch_out_time",
        lat: "latitude_out",
        lng: "longitude_out",
        addr: "out_address",
        image: "punch_out_image",
        by: "punched_out_by",
      }
      : punchType === PUNCH_TYPES.MID_IN
        ? {
          time: "mid_shift_punch_in_time",
          lat: "latitude_mid_in",
          lng: "longitude_mid_in",
          addr: "mid_in_address",
          image: "mid_shift_punch_in_image",
          by: "mid_shift_punched_in_by",
        }
        : {
          time: "punch_in_time",
          lat: "latitude_in",
          lng: "longitude_in",
          addr: "in_address",
          image: "punch_in_image",
          by: "punched_in_by",
        };
  const punchTimeFallbackExpression =
    punchType === PUNCH_TYPES.MID_IN
      ? "NOW()"
      : "NOW() AT TIME ZONE 'Asia/Kolkata'";

  const updateQuery = `
    UPDATE attendance SET 
      ${punchFieldMap.time} = COALESCE(${punchFieldMap.time}, ${punchTimeFallbackExpression}),
      ${punchFieldMap.lat} = COALESCE(${punchFieldMap.lat}, $1),
      ${punchFieldMap.lng} = COALESCE(${punchFieldMap.lng}, $2),
      ${punchFieldMap.addr} = COALESCE(${punchFieldMap.addr}, $3),
      ${punchFieldMap.image} = COALESCE(${punchFieldMap.image}, $4),
      ${punchFieldMap.by} = COALESCE(${punchFieldMap.by}, $5)
    WHERE attendance_id = $6
    RETURNING *
  `;

  const result = await pool.query(updateQuery, [
    locationData.latitude,
    locationData.longitude,
    locationData.address,
    imageUrl,
    normalizeId(userId) ?? null, // ? PERF FIX: userId already auth'd by JWT, no DB call needed
    attendanceId,
  ]);

  if (result.rowCount === 0) {
    throw new Error("Attendance update failed");
  }

  const record = result.rows[0];
  if (faceMatchMeta) {
    record.face_similarity = faceMatchMeta.similarity;
    record.face_match_threshold = faceMatchMeta.threshold;
  }

  return record;
}

// ? PERF FIX: resolvePunchActor removed � userId from JWT is already authenticated.
// Using normalizeId(userId) directly in processPunch saves one DB round trip per punch.

function resolveS3ObjectKey(reference) {
  if (!reference) {
    return null;
  }

  if (reference.includes("://")) {
    try {
      const url = new URL(reference);
      return decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
    } catch (error) {
      console.warn("resolveS3ObjectKey: unable to parse URL", error);
      return null;
    }
  }

  return reference.replace(/^\/+/u, "");
}

async function streamToBuffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadFaceBuffer(faceEmbedding, employeeId = null, empCode = null) {
  if (!faceEmbedding) return null;
  const faceKey = resolveS3ObjectKey(faceEmbedding);
  const defaultBucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const buckets = [...new Set([AWS_S3_BUCKET, SECONDARY_S3_BUCKET, defaultBucket].filter(Boolean))];

  safeDebugLog(`[${new Date().toISOString()}] loadFaceBuffer: buckets resolved to ${JSON.stringify(buckets)}`);

  if (faceKey) {
    for (const bucket of buckets) {
      try {
        const resp = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: faceKey })
        );
        return await streamToBuffer(resp.Body);
      } catch (_err) {
        safeDebugLog(`[${new Date().toISOString()}] loadFaceBuffer direct S3 fetch failed for bucket ${bucket}: ${_err?.message || _err}`);
      }
    }
  }

  // ??? Self-Healing Prefix Scan if the direct key fails
  if (employeeId) {
    const candidatePrefixes = [
      `faces/${employeeId}/`,
      empCode ? `faces/${empCode}/` : null,
      `${employeeId}/`,
      empCode ? `${empCode}/` : null,
    ].filter(Boolean);

    for (const bucket of buckets) {
      for (const prefix of candidatePrefixes) {
        try {
          const listResp = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1,
          }));
          const foundKey = listResp?.Contents?.[0]?.Key;
          if (foundKey) {
            const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: foundKey }));
            const buffer = await streamToBuffer(obj.Body);
            
            // Backfill the database so next time is a direct hit
            console.log(`[Self-Healing] Correcting stale face_embedding for emp_id ${employeeId}: ${foundKey}`);
            pool.query("UPDATE employee SET face_embedding = $1 WHERE emp_id = $2", [foundKey, employeeId]).catch(()=>{});
            
            return buffer;
          }
        } catch (_err) {}
      }
    }
  }

  const publicUrl = buildPublicFaceUrl(faceEmbedding) || faceEmbedding || null;
  if (publicUrl) {
    if (isBackblazeUrl(publicUrl)) {
      const backblazeRef = parseBackblazeUrl(publicUrl);
      if (backblazeRef && hasBackblazeCredentials()) {
        try {
          const { stream } = await fetchBackblazeStream(backblazeRef.bucket, backblazeRef.key);
          return await streamToBuffer(stream);
        } catch (_err) {
          // Fall through to axios if Backblaze auth fails
        }
      }
    }

    try {
      const resp = await axios.get(publicUrl, { responseType: "arraybuffer" });
      return Buffer.from(resp.data);
    } catch (_err) {
      return null;
    }
  }

  return null;
}

async function fetchSupervisorFaceEmbeddings(supervisorId, wardId) {
  if (!supervisorId) return [];
  const { rows } = await pool.query(
    `
      SELECT DISTINCT e.emp_id, e.emp_code, e.name, e.face_embedding
        FROM employee e
        LEFT JOIN wards w ON e.ward_id = w.ward_id
       WHERE e.face_embedding IS NOT NULL
         AND ($2::int IS NULL OR e.ward_id = $2::int)
         AND (
           EXISTS (
             SELECT 1 FROM supervisor_ward sw
             WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_kothi_access uk
             WHERE uk.ward_id = e.ward_id AND uk.user_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM supervisor_kothi sk
             WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_zone_access uz
             WHERE uz.zone_id = w.zone_id AND uz.user_id = $1
           )
         )
    `,
    [supervisorId, wardId]
  );
  return rows || [];
}

async function fallbackMatchByCompare(
  faceBuffer,
  supervisorId,
  wardId,
  threshold
) {
  if (!faceBuffer || !supervisorId) return null;

  // Be a bit more tolerant for roster fallback to avoid false negatives
  const compareThreshold = Math.max(85, Math.min(threshold || 97, 95));

  const candidates = await fetchSupervisorFaceEmbeddings(supervisorId, wardId);
  if (!candidates || candidates.length === 0) return null;

  // Run candidate image download and AWS CompareFaces in parallel
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const sourceBuffer = await loadFaceBuffer(
          candidate.face_embedding,
          candidate.emp_id,
          candidate.emp_code
        );
        if (!sourceBuffer) return null;

        const resp = await rekognition.send(
          new CompareFacesCommand({
            SourceImage: { Bytes: sourceBuffer },
            TargetImage: { Bytes: faceBuffer },
            SimilarityThreshold: compareThreshold,
          })
        );
        const similarity = resp?.FaceMatches?.[0]?.Similarity ?? 0;
        if (similarity >= compareThreshold) {
          return { candidate, similarity, sourceBuffer };
        }
      } catch (err) {
        // ignore individual candidate errors
      }
      return null;
    })
  );

  // Find the candidate with the highest similarity
  let best = null;
  for (const res of results) {
    if (res && (!best || res.similarity > best.similarity)) {
      best = {
        employee: res.candidate,
        similarity: res.similarity,
        sourceBuffer: res.sourceBuffer,
      };
    }
  }

  if (best) {
    // ?? AUTO-HEAL: If this employee's face is not in the Rekognition collection,
    // index it now in the background so future punches match instantly!
    const collectionId = (process.env.REKOGNITION_COLLECTION || process.env.REKOGNITION_COLLECTION_ID || "employee").trim();
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
    if (collectionId && bucket && best.sourceBuffer) {
      rekognition.send(new IndexFacesCommand({
        CollectionId: collectionId,
        Image: { Bytes: best.sourceBuffer },
        ExternalImageId: best.employee.emp_id.toString(),
        MaxFaces: 1,
        QualityFilter: "NONE"
      })).then((indexResp) => {
        const newFaceId = indexResp.FaceRecords?.[0]?.Face?.FaceId;
        const newConfidence = indexResp.FaceRecords?.[0]?.Face?.Confidence;
        if (newFaceId) {
          console.log(`[Auto-Heal-Index] Successfully indexed emp_id ${best.employee.emp_id} -> FaceId ${newFaceId}`);
          pool.query(
            "UPDATE employee SET face_id = $1, face_confidence = $2 WHERE emp_id = $3",
            [newFaceId, newConfidence, best.employee.emp_id]
          ).catch(() => {});
        }
      }).catch((err) => {
        console.error(`[Auto-Heal-Index] Failed to index emp_id ${best.employee.emp_id}:`, err.message);
      });
    }

    return {
      employee: best.employee,
      similarity: best.similarity
    };
  }

  return null;
}

async function resolveAttendanceEmployeeId(attendanceId) {
  if (!attendanceId) {
    return null;
  }

  try {
    const { rows } = await pool.query(
      "SELECT emp_id FROM attendance WHERE attendance_id = $1",
      [attendanceId]
    );
    return rows[0]?.emp_id ?? null;
  } catch (error) {
    console.error("resolveAttendanceEmployeeId error:", error);
    return null;
  }
}

async function ensureFaceMatch(employeeId, attendanceKey, threshold) {
  if (!employeeId) {
    const err = new Error("Unable to determine employee for attendance record");
    err.statusCode = 400;
    throw err;
  }

  const { rows } = await pool.query(
    "SELECT face_embedding, emp_code FROM employee WHERE emp_id = $1",
    [employeeId]
  );

  if (!rows.length) {
    const err = new Error("Employee not found for face verification");
    err.statusCode = 404;
    throw err;
  }

  const faceEmbedding = rows[0].face_embedding;
  const empCode = rows[0].emp_code;
  if (!faceEmbedding) {
    const err = new Error("Employee face enrollment is missing");
    err.statusCode = 412;
    err.details = "Ask the employee to store their face before marking attendance.";
    throw err;
  }

  const faceKey = resolveS3ObjectKey(faceEmbedding);
  let sourceImage = null;

  // ??? MULTI-BUCKET RESOLUTION (Trying all possible buckets from environment)
  const bucketsToTry = [
    AWS_S3_BUCKET,
    process.env.AWS_S3_BUCKET,
    process.env.S3_BUCKET_NAME,
    SECONDARY_S3_BUCKET,
    process.env.SECONDARY_S3_BUCKET,
    "attendease-public",
    "attendease-attendance"
  ].filter(Boolean);

  const uniqueBuckets = [...new Set(bucketsToTry)];

  if (faceKey) {
    for (const bucket of uniqueBuckets) {
      try {
        const resp = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: faceKey })
        );
        const buffer = await streamToBuffer(resp.Body);
        sourceImage = { Bytes: buffer };
        console.log(`[FaceMatch] Found source face in bucket: ${bucket}`);
        break;
      } catch (_err) {
        // continue to next bucket
      }
    }
  }

  // ? PERF FIX: S3 prefix scan wrapped in 1.5s timeout.
  // Previously could take 4-10s (up to 16 sequential S3 ListObjects calls on stale key).
  // Now: if scan doesn't finish in 1.5s, punch proceeds without it (same existing null path).
  if (!sourceImage) {
    const candidatePrefixes = [
      `faces/${employeeId}/`,
      empCode ? `faces/${empCode}/` : null,
      `${employeeId}/`,
      empCode ? `${empCode}/` : null,
    ].filter(Boolean);

    const scanPromise = (async () => {
      for (const bucket of uniqueBuckets) {
        for (const prefix of candidatePrefixes) {
          try {
            const resp = await s3.send(
              new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 })
            );
            const key = resp?.Contents?.[0]?.Key;
            if (key) {
              const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
              const buffer = await streamToBuffer(obj.Body);
              console.log(`[Self-Healing] Backfilling face_embedding for employee ${employeeId} with key from ${bucket}: ${key}`);
              pool.query(
                "UPDATE employee SET face_embedding = $1 WHERE emp_id = $2",
                [key, employeeId]
              ).catch(e => console.error(`Failed to backfill face_embedding for ${employeeId}:`, e));
              return { Bytes: buffer };
            }
          } catch (_err) {
            // ignore and continue search
          }
        }
      }
      return null;
    })();

    const timeoutPromise = new Promise(resolve => setTimeout(() => {
      console.warn(`[Self-Healing] S3 prefix scan timed out for emp_id=${employeeId}, proceeding without it`);
      resolve(null);
    }, 1500));

    sourceImage = await Promise.race([scanPromise, timeoutPromise]);
  }

  // Fallback: fetch via public URL or Backblaze private fetch
  if (!sourceImage) {
    const publicUrl = buildPublicFaceUrl(faceEmbedding) || faceEmbedding || null;
    if (publicUrl) {
      if (isBackblazeUrl(publicUrl)) {
        const backblazeRef = parseBackblazeUrl(publicUrl);
        if (backblazeRef && hasBackblazeCredentials()) {
          try {
            const { stream } = await fetchBackblazeStream(backblazeRef.bucket, backblazeRef.key);
            const buffer = await streamToBuffer(stream);
            sourceImage = { Bytes: buffer };
          } catch (err) {
            console.error("ensureFaceMatch: backblaze fetch failed", err?.message || err);
          }
        }
      }

      if (!sourceImage) {
        try {
          const resp = await axios.get(publicUrl, { responseType: "arraybuffer" });
          sourceImage = { Bytes: Buffer.from(resp.data) };
        } catch (err) {
          console.error("ensureFaceMatch: public fetch failed", err?.message || err);
        }
      }
    }
  }

  if (!sourceImage) {
    console.warn(
      `ensureFaceMatch: source face not found for emp ${employeeId} in any bucket (${uniqueBuckets.join(', ')}); skipping face verification`
    );
    return null; // do not block punch; caller will proceed without face similarity
  }

  const targetBucket = AWS_S3_BUCKET || process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  if (!targetBucket) {
    const err = new Error("Attendance bucket not configured for face verification");
    err.statusCode = 500;
    throw err;
  }

  const compareCommand = new CompareFacesCommand({
    SourceImage: sourceImage,
    TargetImage: {
      S3Object: {
        Bucket: targetBucket,
        Name: attendanceKey,
      },
    },
    SimilarityThreshold: threshold,
  });

  let compareResponse;
  try {
    compareResponse = await rekognition.send(compareCommand);
  } catch (error) {
    error.statusCode = error.$metadata?.httpStatusCode || 500;
    throw error;
  }

  const bestMatch = compareResponse?.FaceMatches?.[0];
  const similarity = bestMatch?.Similarity ?? 0;

  if (!bestMatch || similarity < threshold) {
    const err = new Error("Captured face does not match enrolled face");
    err.statusCode = 403;
    err.details = `Similarity ${similarity.toFixed(2)}% below threshold ${threshold}%`;
    throw err;
  }

  return { similarity, threshold };
}

// Routes
router.post("/", async (req, res) => {
  const { emp_id } = req.body;
  const attendanceDate = resolveAttendanceDate(req.body, req.query);

  try {
    const attendance = await getOrCreateAttendanceRecord(
      emp_id,
      attendanceDate
    );
    res.json(attendance);
  } catch (error) {
    console.error("Error in attendance route: ", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/", upload.single("image"), async (req, res) => {
  const { attendance_id, punch_type, latitude, longitude, address, userId } =
    req.body;
  if (req.file) {
    await ensureNormalizedCaptureFile(req.file);
  }

  if (!attendance_id || !punch_type || !latitude || !longitude || !address) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Fetch the attendance record to get emp_id
    const attendanceResult = await pool.query(
      `SELECT emp_id, date FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (attendanceResult.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    const { emp_id: attendanceEmpId, date: recordDate } = attendanceResult.rows[0];
    const attendanceDate = formatDate(new Date(recordDate));
    const punchType = normalizePunchType(punch_type);

    // ?? Session-aware validation (prevents re-punch-in + night shift support)
    const sessionError = await validatePunchSession(attendanceEmpId, attendanceDate, punchType);
    if (sessionError) {
      return res.status(sessionError.status).json({
        error: sessionError.error,
        code: sessionError.code,
      });
    }

    // For punch-out: use the OPEN session's attendance_id (night-shift carry-forward)
    let targetAttendanceId = attendance_id;
    if (punchType === PUNCH_TYPES.OUT) {
      const openSession = await fetchRecentOpenAttendance(attendanceEmpId, attendanceDate);
      if (openSession && openSession.attendance_id !== attendance_id) {
        targetAttendanceId = openSession.attendance_id;
      }
    }

    const updated = await processPunch(
      targetAttendanceId,
      punchType,
      req.file,
      userId,
      {
        latitude,
        longitude,
        address,
      },
      {
        employeeId: attendanceEmpId,
        requireFaceMatch: false,
      }
    );

    res.json({
      message: `Punch ${punchType} updated successfully`,
      attendance: updated,
    });
  } catch (error) {
    console.error("Error updating attendance:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/image", async (req, res) => {
  const { attendance_id, punch_type } = req.query;

  if (!attendance_id || !punch_type) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const requestedPunchType = normalizePunchType(punch_type);
    const imageColumn =
      requestedPunchType === PUNCH_TYPES.OUT
        ? "punch_out_image"
        : requestedPunchType === PUNCH_TYPES.MID_IN
          ? "mid_shift_punch_in_image"
          : "punch_in_image";

    const result = await pool.query(
      `SELECT ${imageColumn} AS image_url FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (result.rows.length === 0 || !result.rows[0].image_url) {
      return res.status(404).json({ error: "Image not found" });
    }

    const imageUrl = result.rows[0].image_url;
    const backblazeReference = parseBackblazeUrl(imageUrl);
    let downloadName = `attendance_${attendance_id}_${punch_type}.jpg`;
    if (isS3Image(imageUrl)) {
      const key = extractS3Key(imageUrl);
      if (key) {
        downloadName = path.basename(key);
      }
    } else if (backblazeReference?.key) {
      downloadName = path.basename(backblazeReference.key);
    } else if (typeof imageUrl === "string") {
      try {
        const parsed = new URL(imageUrl);
        downloadName = path.basename(parsed.pathname);
      } catch (_error) {
        downloadName = path.basename(imageUrl);
      }
    }

    if (isLocalImage(imageUrl)) {
      const filePath = getLocalImagePath(imageUrl);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Image not found" });
      }

      res.set({
        "Content-Type": "image/jpeg",
        "Content-Disposition": `inline; filename="${downloadName}"`,
      });

      return fs.createReadStream(filePath).pipe(res);
    }

    if (isS3Image(imageUrl)) {
      const key = extractS3Key(imageUrl);

      if (!key) {
        return res.status(404).json({ error: "Image not found" });
      }

      try {
        const { stream, contentType } = await getS3ImageStream(key);

        res.set({
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${downloadName}"`,
        });

        return stream.pipe(res);
      } catch (error) {
        console.error("Error streaming S3 image:", error);
        return res.status(500).json({ error: "Unable to fetch image from S3" });
      }
    }

    if (backblazeReference && isBackblazeUrl(imageUrl)) {
      if (!hasBackblazeCredentials()) {
        console.warn(
          "Backblaze image requested but credentials are not configured in environment variables."
        );
        return res.status(502).json({
          error: "Backblaze download unavailable",
          details:
            "Configure B2_KEY_ID and B2_APPLICATION_KEY in the backend environment to stream private Backblaze images.",
        });
      }

      try {
        const { stream, contentType } = await fetchBackblazeStream(
          backblazeReference.bucket,
          backblazeReference.key
        );

        res.set({
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${downloadName}"`,
        });

        return stream.pipe(res);
      } catch (error) {
        if (error?.response?.status === 404) {
          return res.status(404).json({ error: "Image not found" });
        }
        console.error("Error streaming Backblaze image:", error);
        return res.status(502).json({
          error: "Unable to fetch image from Backblaze",
          details: error?.message || "Request to Backblaze failed",
        });
      }
    }

    if (imageUrl?.startsWith("http")) {
      const imageResponse = await axios.get(imageUrl, {
        responseType: "stream",
      });

      res.set({
        "Content-Type":
          imageResponse.headers["content-type"] || "image/jpeg",
        "Content-Disposition": `inline; filename="${downloadName}"`,
      });

      return imageResponse.data.pipe(res);
    }

    res.status(404).json({ error: "Image not found" });
  } catch (error) {
    console.error("Error fetching image:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/face-attendance", upload.single("image"), async (req, res) => {
  try {
    safeDebugLog(`[${new Date().toISOString()}] /face-attendance hit! mode: ${req.body?.groupMode}`);
    const {
      punch_type: rawPunchType,
      latitude: rawLatitude,
      longitude: rawLongitude,
      userId,
      address,
      emp_id: rawEmpId,
      employeeId: rawEmployeeId,
      groupMode,
      group_mode: groupModeAlias,
      mode: rawMode,
      faceMatchThreshold: rawThreshold,
      ward_id: rawWardId,
      wardId: rawWardIdAlt,
    } = req.body;
    const attendanceDate = resolveAttendanceDate(req.body, req.query);
    const wardId = normalizeId(rawWardId ?? rawWardIdAlt ?? null);
    const supervisorId = normalizeId(
      userId ?? req.body?.supervisor_id ?? req.body?.user_id
    );

    if (!req.file) {
      return res.status(400).json({
        error: "Face image is required",
      });
    }
    await ensureNormalizedCaptureFile(req.file);

    const normalizedCaptureBuffer = req.file.buffer;
    const collectionId = resolveCollectionId();
    if (!collectionId) {
      return res.status(500).json({
        error: "Rekognition collection is not configured",
        details:
          "Set REKOGNITION_COLLECTION or REKOGNITION_COLLECTION_ID in the backend .env file.",
      });
    }

    await ensureCollectionExists(collectionId);

    const punchType = normalizePunchType(rawPunchType);

    const thresholdCandidate = Number(rawThreshold);
    const matchThreshold = Number.isFinite(thresholdCandidate)
      ? thresholdCandidate
      : DEFAULT_FACE_MATCH_THRESHOLD;

    const locationPayload = {
      latitude:
        rawLatitude !== undefined && rawLatitude !== null && rawLatitude !== ""
          ? rawLatitude
          : "0",
      longitude:
        rawLongitude !== undefined &&
          rawLongitude !== null &&
          rawLongitude !== ""
          ? rawLongitude
          : "0",
      address: address ?? "",
    };

    const groupModeRequested = isGroupModeRequest(
      groupMode,
      groupModeAlias,
      rawMode
    );

    console.log("[face-attendance] groupMode:", groupMode, "| mode:", rawMode, "| groupModeRequested:", groupModeRequested);

    if (groupModeRequested) {
      const groupTrackingCityId = await resolveRequestCityId({
        wardId,
        supervisorId,
      });
      const groupTracking = {
        cityId: groupTrackingCityId,
        source: "group_attendance",
        metricDate: attendanceDate,
      };
      const detectCommand = new DetectFacesCommand({
        Image: { Bytes: normalizedCaptureBuffer },
        Attributes: ["DEFAULT"],
      });

      const detectResult = await sendTrackedAttendanceRekognition(detectCommand, groupTracking);
      const faceDetails = detectResult?.FaceDetails ?? [];

      console.log("[face-attendance] Detected faces:", faceDetails.length);

      if (!faceDetails.length) {
        return res.status(422).json({
          error: "No faces detected in the image",
          suggestion: "Ensure group members are clearly visible and retry.",
        });
      }

      if (faceDetails.length > 10) {
        console.log("[face-attendance] BLOCKING: too many faces:", faceDetails.length);
        return res.status(422).json({
          error: "Please reduce the people count to 10",
          details: `Detected ${faceDetails.length} faces. Maximum allowed is 10.`,
          suggestion: "Capture the photo with 10 or fewer people and retry.",
        });
      }

      const imageMetadata = await sharp(normalizedCaptureBuffer).metadata();
      const imageWidth = imageMetadata?.width ?? null;
      const imageHeight = imageMetadata?.height ?? null;

      if (!imageWidth || !imageHeight) {
        return res.status(400).json({
          error: "Unable to read image dimensions for face processing",
        });
      }

      // --- PARALLEL GROUP PUNCH ------------------------------------------------
      // All faces processed simultaneously. 5 faces that took 40s now take ~8s.
      // Each face is fully independent � no shared mutable state inside the map.
      // processedEmployees dedup is done as a post-pass on the collected results.
      // -------------------------------------------------------------------------
      const groupThreshold = Math.max(88, Math.min(matchThreshold, 92));

      const perFaceResults = await mapLimit(
        faceDetails,
        2,
        async (faceDetail, index) => {
          const faceIndex = index + 1;

          // -- 1. Crop face --------------------------------------------------
          const cropRegion = computeCropRegion(faceDetail.BoundingBox, imageWidth, imageHeight);
          if (!cropRegion) {
            return { faceIndex, status: "skipped", message: "Unable to crop the detected face region." };
          }

          let faceImageBuffer;
          try {
            faceImageBuffer = await sharp(normalizedCaptureBuffer)
              .extract(cropRegion)
              .resize(600, 600, { fit: "cover" })
              .toBuffer();
          } catch (cropError) {
            console.error("[Group] face crop failed", cropError);
            return { faceIndex, status: "error", message: "Unable to process the detected face region." };
          }

          // -- 2. Rekognition face search ------------------------------------
          // ?? COST OPT: QualityFilter=AUTO skips low-quality/blurry crops before
          // AWS charges for them. DetectFaces already confirmed a face exists here.
          let searchResult;
          try {
            // Validate image buffer immediately before SearchFacesByImage call
            const maxImageSizeBytes = 5 * 1024 * 1024;
            const allowedMimetypes = ["image/jpeg", "image/jpg", "image/png"];
            const mimeTypeOk = req.file?.mimetype ? allowedMimetypes.includes(req.file.mimetype.toLowerCase()) : true;
            const isBufferValid = faceImageBuffer && faceImageBuffer.length > 0 && faceImageBuffer.length <= maxImageSizeBytes;

            if (!isBufferValid || !mimeTypeOk) {
              return {
                faceIndex,
                status: "skipped",
                similarity: null,
                matched: false,
                reason: "invalid_image",
                message: "Face crop too small/invalid. Please recapture."
              };
            }

            searchResult = await withTimeout(
              sendTrackedAttendanceRekognition(new SearchFacesByImageCommand({
                CollectionId: collectionId,
                Image: { Bytes: faceImageBuffer },
                MaxFaces: 1,
                FaceMatchThreshold: groupThreshold,
              }), groupTracking),
              GROUP_FACE_SEARCH_TIMEOUT_MS,
              "Face search timed out"
            );
          } catch (searchError) {
            const parsed = parseRekognitionError(searchError);
            if (parsed.isExpected) {
              console.warn(
                `[GroupPunch - Face ${faceIndex}] Expected Rekognition error: ` +
                `type=${parsed.reason} msg=${parsed.message} reqId=${parsed.requestId || "n/a"}`
              );
              if (parsed.reason === "no_face") {
                return {
                  faceIndex,
                  status: "unmatched",
                  similarity: null,
                  matched: false,
                  reason: "no_face",
                  message: "No clear face detected in this crop. Please recapture."
                };
              }
              if (parsed.reason === "rekognition_throttled") {
                return {
                  faceIndex,
                  status: "error",
                  similarity: null,
                  matched: false,
                  reason: "rekognition_throttled",
                  message: "AWS Rekognition service throttled. Please retry."
                };
              }
              if (parsed.reason === "timeout") {
                return {
                  faceIndex,
                  status: "error",
                  similarity: null,
                  matched: false,
                  reason: "timeout",
                  message: "Face search timed out. Please retry."
                };
              }
            }

            console.error("[Group] face search failed unexpectedly:", searchError);
            if (searchError?.Code === "InvalidParameterException" || searchError?.name === "InvalidParameterException") {
              return { faceIndex, status: "unmatched", similarity: null, message: "No clear face detected in this crop. Please recapture." };
            }
            const { payload } = mapRekognitionError(searchError);
            return { faceIndex, status: "error", message: payload?.details || payload?.error || "Face recognition failed" };
          }

          const bestMatch = searchResult?.FaceMatches?.[0] ?? null;
          let employeeRecord = null;
          let similarity = bestMatch?.Similarity ?? null;

          // -- 3. Resolve employee -------------------------------------------
          if (bestMatch?.Face) {
            employeeRecord = await resolveEmployeeFromFaceIdentifiers({
              faceId: bestMatch.Face.FaceId,
              matchedExternalId: bestMatch.Face.ExternalImageId ?? null,
              requestedEmpId: null,
            });
          }

          // Group-only safe fallback: roster-level CompareFaces
          // ?? COST OPT: GROUP_FALLBACK_ENABLED guards this path.
          // Each call here = N paid CompareFaces calls (N = employees in ward).
          // Only trigger when collection misses AND fallback is enabled.
          if (!employeeRecord && supervisorId && GROUP_FALLBACK_ENABLED) {
            const fallback = await fallbackMatchByCompare(
              faceImageBuffer, supervisorId, wardId,
              Math.max(85, Math.min(matchThreshold, 90))
            );
            if (fallback?.employee) {
              employeeRecord = fallback.employee;
              similarity = fallback.similarity ?? similarity;
            }
          }

          if (!employeeRecord) {
            return {
              faceIndex, status: "unmatched", similarity: null,
              message: "Face not recognized in collection/roster. Please capture clearer image or re-enroll face.",
              hint: "Ensure this employee's face photo is uploaded in the face gallery before using group attendance.",
            };
          }

          // -- 4. LAYER 2: CompareFaces cross-check (only if enabled) --------
          if (GROUP_DOUBLE_VERIFY_ENABLED) {
            const DOUBLE_VERIFY_THRESHOLD = 90;
            try {
              const enrolledBuffer = await loadFaceBuffer(employeeRecord.face_embedding, employeeRecord.emp_id);
              if (enrolledBuffer) {
                const crossCheck = await withTimeout(
                  sendTrackedAttendanceRekognition(new CompareFacesCommand({
                    SourceImage: { Bytes: enrolledBuffer },
                    TargetImage: { Bytes: faceImageBuffer },
                    SimilarityThreshold: DOUBLE_VERIFY_THRESHOLD,
                  }), groupTracking),
                  GROUP_FACE_SEARCH_TIMEOUT_MS,
                  "Face secondary verification timed out"
                );
                const crossSimilarity = crossCheck?.FaceMatches?.[0]?.Similarity ?? 0;
                if (crossSimilarity < DOUBLE_VERIFY_THRESHOLD) {
                  console.warn(`[Group] Double-verify FAILED emp_id=${employeeRecord.emp_id}: rekog=${similarity?.toFixed(1)}% compare=${crossSimilarity.toFixed(1)}%`);
                  return { faceIndex, status: "unmatched", similarity: crossSimilarity, message: "Face verification failed secondary check. Please recapture.", code: "DOUBLE_VERIFY_FAILED" };
                }
              }
            } catch (crossErr) {
              console.warn(`[Group] Double-verify skipped emp_id=${employeeRecord.emp_id}:`, crossErr.message);
            }
          }

          // -- 5. LAYER 3: Supervisor roster cross-check ---------------------
          if (supervisorId) {
            const rosterCheck = await pool.query(
              `SELECT 1 FROM employee e
               LEFT JOIN wards w ON e.ward_id = w.ward_id
               WHERE e.emp_id = $1 AND (
                 EXISTS (
                   SELECT 1 FROM supervisor_ward sw
                   WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $2
                 )
                 OR EXISTS (
                   SELECT 1 FROM user_kothi_access uk
                   WHERE uk.ward_id = e.ward_id AND uk.user_id = $2
                 )
                 OR EXISTS (
                   SELECT 1 FROM supervisor_kothi sk
                   WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $2
                 )
                 OR EXISTS (
                   SELECT 1 FROM user_zone_access uz
                   WHERE uz.zone_id = w.zone_id AND uz.user_id = $2
                 )
               ) LIMIT 1`,
              [employeeRecord.emp_id, supervisorId]
            );
            if (rosterCheck.rowCount === 0) {
              console.warn(`[Group] Roster FAILED emp_id=${employeeRecord.emp_id} supervisor=${supervisorId}`);
              return { faceIndex, status: "skipped", similarity, employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, message: "Employee does not belong to this supervisor's ward.", code: "UNAUTHORIZED_WARD" };
            }
          }

          // -- 6. Leave check ------------------------------------------------
          try {
            const leaveCheck = await pool.query(
              `SELECT leave_type FROM attendance
               WHERE emp_id = $1 AND date = $2::date
               ORDER BY attendance_id DESC LIMIT 1`,
              [employeeRecord.emp_id, attendanceDate]
            );
            const leaveRow = leaveCheck?.rows?.[0];
            if (leaveRow?.leave_type) {
              return { faceIndex, status: "skipped", employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, similarity, message: `Leave already marked (${leaveRow.leave_type}). Punch skipped.`, code: "LEAVE_MARKED" };
            }
          } catch (leaveErr) {
            console.error(`[Group] Leave-check failed emp_id=${employeeRecord.emp_id}:`, leaveErr?.message);
          }

          // -- 7. Session validation (prevents double punch-in) --------------
          const sessionError = await validatePunchSession(employeeRecord.emp_id, attendanceDate, punchType);
          if (sessionError) {
            return { faceIndex, status: "skipped", employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, similarity, message: sessionError.error, code: sessionError.code };
          }

          // -- 8. Geofencing -------------------------------------------------
          const geoCheck = await validateGeofencing(employeeRecord.emp_id, locationPayload.latitude, locationPayload.longitude);
          if (!geoCheck.allowed) {
            return { faceIndex, status: "skipped", employeeId: employeeRecord.emp_id, employeeName: employeeRecord.name, similarity, message: geoCheck.message || "Out of assigned zone", code: "OUT_OF_GEofence" };
          }

          // -- 9. Create attendance record & punch ---------------------------
          const attendance = await getOrCreateAttendanceRecord(
            employeeRecord.emp_id, attendanceDate, { punchType, createIfMissing: true }
          );
          const updated = await processPunch(
            attendance.attendance_id, punchType,
            { buffer: faceImageBuffer },
            userId, locationPayload,
            {
              employeeId: employeeRecord.emp_id,
              requireFaceMatch: false,      // Already verified by Rekognition above
              faceMatchThreshold: matchThreshold,
            }
          );

          return {
            faceIndex,
            status: "punched",
            employeeId: employeeRecord.emp_id,
            employeeName: employeeRecord.name,
            similarity,
            attendanceId: attendance.attendance_id,
            punchedAt: formatPunchTimeForClient(resolvePunchRecordTime(updated, punchType)),
          };
        }
      );

      // Flatten allSettled ? plain results array
      const rawResults = perFaceResults.map((settled, i) => {
        if (settled.status === "fulfilled") return settled.value;
        console.error(`[Group] Face ${i + 1} threw unexpectedly:`, settled.reason?.message);
        return { faceIndex: i + 1, status: "error", message: settled.reason?.message || "Face processing failed" };
      });

      // Post-dedup: if same employee matched on two crops, keep first, mark rest duplicate
      const seenEmpIds = new Set();
      const results = rawResults.map((r) => {
        if (r.status === "punched" && r.employeeId != null) {
          if (seenEmpIds.has(r.employeeId)) {
            return { faceIndex: r.faceIndex, status: "duplicate", similarity: r.similarity ?? null, employeeId: r.employeeId, employeeName: r.employeeName, message: "Employee already processed in this capture." };
          }
          seenEmpIds.add(r.employeeId);
        }
        return r;
      });


      const punchedCount = results.filter(
        (entry) => entry.status === "punched"
      ).length;

      safeDebugLog(`[${new Date().toISOString()}] Group Punch Results: ${JSON.stringify(results)}`);

      if (punchedCount > 0) {
        trackSuccessfulAttendanceEvent({
          cityId: groupTrackingCityId,
          source: "group_attendance",
          metricDate: attendanceDate,
          attendanceCount: punchedCount,
        });
      }

      return res.json({
        success: punchedCount > 0,
        mode: "group",
        punch_type: punchType,
        total_faces: faceDetails.length,
        punched_count: punchedCount,
        results,
      });
    }

    const requestedEmpId = normalizeId(rawEmpId ?? rawEmployeeId);
    const individualTrackingCityId = await resolveRequestCityId({
      wardId,
      supervisorId,
      employeeId: requestedEmpId,
    });
    const individualTracking = {
      cityId: individualTrackingCityId,
      source: "individual_attendance",
      metricDate: attendanceDate,
    };
    if (!requestedEmpId) {
      return res.status(400).json({
        error: "Please select an employee first.",
      });
    }

    // 1. Fetch the selected employee
    const employeeRecord = await fetchEmployeeById(requestedEmpId);
    if (!employeeRecord) {
      return res.status(404).json({
        error: "Selected employee not found in the system.",
      });
    }

    // ?? COST OPT: 60-second dedup guard � if same employee punched within
    // the last 60s (network retry scenario), return cached success immediately
    // without making any paid Rekognition API call.
    if (isDuplicatePunch(requestedEmpId, punchType, attendanceDate)) {
      console.log(`[face-attendance] Dedup hit: emp_id=${requestedEmpId} punchType=${punchType} date=${attendanceDate} � skipping Rekognition`);
      return res.status(200).json({
        success: true,
        employee: employeeRecord.name,
        punch_type: punchType,
        face_similarity: null,
        face_match_threshold: matchThreshold,
        time: null,
        deduplicated: true, // flag so client knows it was a cached response
      });
    }

    // 2. Search for the face in the collection
    // Validate image buffer immediately before SearchFacesByImage call
    const maxImageSizeBytes = 5 * 1024 * 1024;
    const allowedMimetypes = ["image/jpeg", "image/jpg", "image/png"];
    const mimeTypeOk = req.file?.mimetype ? allowedMimetypes.includes(req.file.mimetype.toLowerCase()) : true;
    const isBufferValid = normalizedCaptureBuffer && normalizedCaptureBuffer.length > 0 && normalizedCaptureBuffer.length <= maxImageSizeBytes;

    if (!isBufferValid || !mimeTypeOk) {
      return res.status(400).json({
        success: false,
        matched: false,
        reason: "invalid_image",
        error: "Invalid face image buffer"
      });
    }

    let searchResult;
    try {
      searchResult = await withTimeout(
        sendTrackedAttendanceRekognition(new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: normalizedCaptureBuffer },
          MaxFaces: 1,
          FaceMatchThreshold: matchThreshold,
        }), individualTracking),
        GROUP_FACE_SEARCH_TIMEOUT_MS,
        "Face search timed out"
      );
    } catch (searchError) {
      const parsed = parseRekognitionError(searchError);
      if (parsed.isExpected) {
        console.warn(
          `[IndividualPunch] Expected Rekognition error: ` +
          `type=${parsed.reason} msg=${parsed.message} reqId=${parsed.requestId || "n/a"}`
        );
        return res.status(400).json({
          success: false,
          matched: false,
          reason: parsed.reason,
          error: parsed.reason === "no_face" ? "No faces in the image" : "Face search failed",
          details: parsed.message
        });
      } else {
        console.error(`[IndividualPunch] Face search failed unexpectedly:`, searchError);
        throw searchError; // Let it hit the main route catch block
      }
    }

    const matchedFaceResult = searchResult.FaceMatches?.[0];
    const matchedFace = matchedFaceResult?.Face ?? null;

    // ?? STRICT IDENTITY CHECK
    // If we found a face in the system, it MUST resolve to the selected employee.
    if (matchedFace) {
      const matchedExternalRaw = matchedFace.ExternalImageId ?? null;
      const matchedExternalId = normalizeId(matchedExternalRaw);
      const resolvedMatchedEmployee = await resolveEmployeeFromFaceIdentifiers({
        faceId: matchedFace.FaceId ?? null,
        matchedExternalId: matchedExternalRaw,
        requestedEmpId: null,
      });
      const isMatchingSelectedEmployee =
        resolvedMatchedEmployee &&
        String(resolvedMatchedEmployee.emp_id) === String(requestedEmpId);

      if (!isMatchingSelectedEmployee) {
        // Last-chance individual verification against the selected employee.
        // This prevents false mismatch rejects when collection top-match is noisy.
        try {
          const selectedFaceBuffer = await loadFaceBuffer(
            employeeRecord.face_embedding,
            employeeRecord.emp_id,
            employeeRecord.emp_code
          );
          if (selectedFaceBuffer) {
            const directMatch = await sendTrackedAttendanceRekognition(
              new CompareFacesCommand({
                SourceImage: { Bytes: selectedFaceBuffer },
                TargetImage: { Bytes: normalizedCaptureBuffer },
                SimilarityThreshold: Math.max(88, Math.min(matchThreshold, 95)),
              }),
              individualTracking
            );
            const directSimilarity =
              directMatch?.FaceMatches?.[0]?.Similarity ?? 0;
            if (directSimilarity >= Math.max(88, Math.min(matchThreshold, 95))) {
              safeDebugLog(
                `[${new Date().toISOString()}] Individual fallback verify passed for requestedEmpId=${requestedEmpId} with similarity=${directSimilarity}`
              );
            } else {
              const resolvedEmp = resolvedMatchedEmployee?.emp_id ?? null;
              safeDebugLog(`[${new Date().toISOString()}] Individual Punch Failed: Identity Mismatch. Camera saw ${resolvedEmp ?? matchedExternalId}, but supervisor selected ${requestedEmpId}`);
              return res.status(403).json({
                error: "Identity Mismatch",
                details: `The captured face belongs to someone else, not ${employeeRecord.name}.`,
                suggestion: "Ensure you are punching for the correct person.",
              });
            }
          } else {
            const resolvedEmp = resolvedMatchedEmployee?.emp_id ?? null;
            safeDebugLog(`[${new Date().toISOString()}] Individual Punch Failed: Identity Mismatch. Camera saw ${resolvedEmp ?? matchedExternalId}, but supervisor selected ${requestedEmpId}`);
            return res.status(403).json({
              error: "Identity Mismatch",
              details: `The captured face belongs to someone else, not ${employeeRecord.name}.`,
              suggestion: "Ensure you are punching for the correct person.",
            });
          }
        } catch (identityFallbackError) {
          const resolvedEmp = resolvedMatchedEmployee?.emp_id ?? null;
          safeDebugLog(
            `[${new Date().toISOString()}] Individual fallback verify error for requestedEmpId=${requestedEmpId}: ${identityFallbackError?.message || identityFallbackError}`
          );
          safeDebugLog(`[${new Date().toISOString()}] Individual Punch Failed: Identity Mismatch. Camera saw ${resolvedEmp ?? matchedExternalId}, but supervisor selected ${requestedEmpId}`);
          return res.status(403).json({
            error: "Identity Mismatch",
            details: `The captured face belongs to someone else, not ${employeeRecord.name}.`,
            suggestion: "Ensure you are punching for the correct person.",
          });
        }
      }
    }

    // ?? COST OPT: Individual fallback roster loop is DISABLED by default.
    // This path calls CompareFaces for every employee in the ward � very expensive.
    // Collection search missing = face likely not enrolled. Return clear error instead.
    // Enable via INDIVIDUAL_FALLBACK_ENABLED=true in .env ONLY for debugging.
    if (!matchedFace && INDIVIDUAL_FALLBACK_ENABLED) {
      const fallback = await fallbackMatchByCompare(
        normalizedCaptureBuffer,
        supervisorId,
        wardId,
        matchThreshold
      );
      if (fallback?.employee && String(fallback.employee.emp_id) !== String(requestedEmpId)) {
        return res.status(403).json({
          error: "Identity Mismatch",
          details: `Face does not match ${employeeRecord.name}.`,
        });
      } else if (!fallback?.employee) {
        return res.status(403).json({
          error: "Face not recognized",
          details: "The captured face does not match the enrolled face.",
          suggestion: "Ensure good lighting and try again, or re-enroll face."
        });
      }
    } else if (!matchedFace) {
      // Face not found in collection � instruct supervisor to re-enroll
      console.log(`[face-attendance] Individual: no collection match for emp_id=${requestedEmpId}. Fallback disabled.`);
      
      // Attempt a cheap direct 1:1 comparison with the selected employee
      let directMatchPassed = false;
      try {
        const selectedFaceBuffer = await loadFaceBuffer(
          employeeRecord.face_embedding,
          employeeRecord.emp_id,
          employeeRecord.emp_code
        );
        if (selectedFaceBuffer) {
          const directMatch = await sendTrackedAttendanceRekognition(
            new CompareFacesCommand({
              SourceImage: { Bytes: selectedFaceBuffer },
              TargetImage: { Bytes: normalizedCaptureBuffer },
              SimilarityThreshold: Math.max(88, Math.min(matchThreshold, 95)),
            }),
            individualTracking
          );
          const directSimilarity = directMatch?.FaceMatches?.[0]?.Similarity ?? 0;
          if (directSimilarity >= Math.max(88, Math.min(matchThreshold, 95))) {
            directMatchPassed = true;
          }
        }
      } catch (err) {
        console.warn("Direct match fallback error:", err.message);
      }

      if (!directMatchPassed) {
        return res.status(403).json({
          error: "Face not recognized",
          details: "The captured face does not match the enrolled face.",
          suggestion: "Ensure good lighting and try again, or re-enroll face."
        });
      }
    }

    const empId = employeeRecord.emp_id;

    // ?? Session-aware validation (prevents re-punch-in + night shift support)
    const sessionError = await validatePunchSession(empId, attendanceDate, punchType);
    if (sessionError) {
      return res.status(sessionError.status).json({
        error: sessionError.error,
        code: sessionError.code,
      });
    }

    // Resolve or create attendance record (handles night-shift carry-forward)
    const attendance = await getOrCreateAttendanceRecord(empId, attendanceDate, {
      punchType,
      createIfMissing: true,
    });

    // ?? Geofencing Validation
    const geoCheck = await validateGeofencing(empId, locationPayload.latitude, locationPayload.longitude);
    if (!geoCheck.allowed) {
      if (geoCheck.notConfigured) {
        // Geofencing rules not set up for this zone/ward yet
        return res.status(403).json({
          error: "Your geofencing location is not mapped yet",
          notConfigured: true,
          details: geoCheck.message || "Please contact admin to configure your zone boundaries."
        });
      }
      // Out of zone
      return res.status(403).json({
        error: "Out of Zone",
        notConfigured: false,
        details: geoCheck.message || "You are outside the allowed geo-fence zone."
      });
    }    // ? PERF FIX: pass context directly so processPunch skips getAttendanceUploadContext DB call
    const punchUploadContext = {
      attendance_date: attendanceDate,
      emp_id: empId,
      emp_code: employeeRecord.emp_code,
      employee_name: employeeRecord.name,
      ward_name: attendance.ward_name ?? null,
      zone_name: null,
      city_name: null,
    };
    const updated = await processPunch(
      attendance.attendance_id,
      punchType,
      req.file,
      userId,
      locationPayload,
      {
        employeeId: empId,
        requireFaceMatch: true,
        faceMatchThreshold: matchThreshold,
        uploadContext: punchUploadContext,
      }
    );

    // ?? SUPERVISOR SECURITY CHECK
    // If requireFaceMatch was true but similarity is null (missing S3),
    // we block the supervisor punch to prevent "any face" matching.
    if (!updated.face_similarity) {
      const err = new Error("Enrolled face image could not be loaded from storage");
      err.statusCode = 412;
      err.details = "Please re-enroll the employee face before marking attendance.";
      throw err;
    }

    safeDebugLog(`[${new Date().toISOString()}] Individual Punch Success: ${employeeRecord.emp_id}`);
    trackSuccessfulAttendanceEvent({
      cityId: individualTrackingCityId,
      source: "individual_attendance",
      metricDate: attendanceDate,
      attendanceCount: 1,
    });
    return res.json({
      success: true,
      employee: employeeRecord.name,
      punch_type: punchType,
      face_similarity: updated.face_similarity ?? null,
      face_match_threshold:
        updated.face_match_threshold ?? matchThreshold,
      time: formatPunchTimeForClient(resolvePunchRecordTime(updated, punchType)),
    });
  } catch (error) {
    console.error("Face attendance error:", error);
    safeDebugLog(`[${new Date().toISOString()}] Face Attendance Route Error: ${error?.stack || error}`);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    const { status, payload } = mapRekognitionError(error);
    res.status(status).json(payload);
  }
});

// Face attendance with AWS liveness pre-check (single employee)
router.post("/face-liveness", upload.single("image"), async (req, res) => {
  try {
    const {
      punch_type: rawPunchType,
      latitude: rawLatitude,
      longitude: rawLongitude,
      userId,
      address,
      emp_id: rawEmpId,
      employeeId: rawEmployeeId,
      faceMatchThreshold: rawThreshold,
    } = req.body;
    const attendanceDate = resolveAttendanceDate(req.body, req.query);

    if (!req.file) {
      return res.status(400).json({ error: "Face image is required" });
    }
    await ensureNormalizedCaptureFile(req.file);

    const collectionId = resolveCollectionId();
    if (!collectionId) {
      return res.status(500).json({
        error: "Rekognition collection is not configured",
        details:
          "Set REKOGNITION_COLLECTION or REKOGNITION_COLLECTION_ID in the backend .env file.",
      });
    }
    await ensureCollectionExists(collectionId);

    const punchType = normalizePunchType(rawPunchType);

    const thresholdCandidate = Number(rawThreshold);
    const matchThreshold = Number.isFinite(thresholdCandidate)
      ? thresholdCandidate
      : DEFAULT_FACE_MATCH_THRESHOLD;

    const locationPayload = {
      latitude:
        rawLatitude !== undefined && rawLatitude !== null && rawLatitude !== ""
          ? rawLatitude
          : "0",
      longitude:
        rawLongitude !== undefined &&
          rawLongitude !== null &&
          rawLongitude !== ""
          ? rawLongitude
          : "0",
      address: address ?? "",
    };

    const livenessTrackingCityId = await resolveRequestCityId({
      wardId,
      supervisorId,
      employeeId: normalizeId(rawEmpId ?? rawEmployeeId),
    });
    const livenessTracking = {
      cityId: livenessTrackingCityId,
      source: "individual_attendance",
      metricDate: attendanceDate,
    };

    // Liveness: ensure exactly one good-quality face
    const detectResult = await sendTrackedAttendanceRekognition(
      new DetectFacesCommand({
        Image: { Bytes: req.file.buffer },
        Attributes: ["ALL"],
      }),
      livenessTracking
    );
    const faces = detectResult?.FaceDetails ?? [];
    if (faces.length !== 1) {
      return res.status(422).json({
        error: "Liveness failed",
        details: `Expected exactly one face, detected ${faces.length}.`,
        suggestion: "Hold the camera steady with only the employee in frame.",
      });
    }

    const [face] = faces;
    const brightness = face?.Quality?.Brightness ?? 0;
    const sharpness = face?.Quality?.Sharpness ?? 0;
    const confidence = face?.Confidence ?? 0;
    const pose = face?.Pose || {};
    const poseOk =
      Math.abs(pose.Roll ?? 0) <= 25 && Math.abs(pose.Yaw ?? 0) <= 25;
    const qualityOk = brightness >= 35 && sharpness >= 35 && confidence >= 80;

    if (!poseOk || !qualityOk) {
      return res.status(422).json({
        error: "Liveness failed",
        details:
          "Face must be centered, upright, and well lit (eye level, good brightness/sharpness).",
        metrics: { brightness, sharpness, confidence, pose },
        suggestion: "Reposition closer to the camera with good lighting and retry.",
      });
    }

    const requestedEmpId = normalizeId(rawEmpId ?? rawEmployeeId);
    
    // Validate image buffer immediately before SearchFacesByImage call
    const maxImageSizeBytes = 5 * 1024 * 1024;
    const allowedMimetypes = ["image/jpeg", "image/jpg", "image/png"];
    const mimeTypeOk = req.file?.mimetype ? allowedMimetypes.includes(req.file.mimetype.toLowerCase()) : true;
    const isBufferValid = req.file?.buffer && req.file.buffer.length > 0 && req.file.buffer.length <= maxImageSizeBytes;

    if (!isBufferValid || !mimeTypeOk) {
      return res.status(400).json({
        success: false,
        matched: false,
        reason: "invalid_image",
        error: "Invalid face image buffer"
      });
    }

    let searchResult;
    try {
      searchResult = await withTimeout(
        sendTrackedAttendanceRekognition(
          new SearchFacesByImageCommand({
            CollectionId: collectionId,
            Image: { Bytes: req.file.buffer },
            MaxFaces: 1,
            FaceMatchThreshold: matchThreshold,
          }),
          livenessTracking
        ),
        GROUP_FACE_SEARCH_TIMEOUT_MS,
        "Face search timed out"
      );
    } catch (searchError) {
      const parsed = parseRekognitionError(searchError);
      if (parsed.isExpected) {
        console.warn(
          `[FaceLiveness] Expected Rekognition error: ` +
          `type=${parsed.reason} msg=${parsed.message} reqId=${parsed.requestId || "n/a"}`
        );
        return res.status(400).json({
          success: false,
          matched: false,
          reason: parsed.reason,
          error: parsed.reason === "no_face" ? "No faces in the image" : "Face search failed",
          details: parsed.message
        });
      } else {
        console.error(`[FaceLiveness] Face search failed unexpectedly:`, searchError);
        throw searchError;
      }
    }

    if (!searchResult.FaceMatches?.length) {
      return res.status(401).json({
        error: "No matching employee found",
        suggestion: "Use manual attendance if face recognition fails",
      });
    }

    const matchedFace = searchResult.FaceMatches[0]?.Face ?? {};
    const faceId = matchedFace.FaceId;
    const matchedExternalId = matchedFace.ExternalImageId ?? null;

    const employeeRecord = await resolveEmployeeFromFaceIdentifiers({
      faceId,
      matchedExternalId,
      requestedEmpId,
    });

    if (!employeeRecord) {
      return res.status(404).json({
        error: "Employee not registered in system",
        solution: "Register face first via /store-face",
      });
    }

    const empId = employeeRecord.emp_id;

    // ?? Session-aware validation (prevents re-punch-in + night shift support)
    const sessionError = await validatePunchSession(empId, attendanceDate, punchType);
    if (sessionError) {
      return res.status(sessionError.status).json({
        error: sessionError.error,
        code: sessionError.code,
      });
    }

    // Resolve or create attendance record (handles night-shift carry-forward)
    const attendance = await getOrCreateAttendanceRecord(empId, attendanceDate, {
      punchType,
      createIfMissing: true,
    });

    const geoCheck = await validateGeofencing(empId, locationPayload.latitude, locationPayload.longitude);
    if (!geoCheck.allowed) {
      if (geoCheck.notConfigured) {
        return res.status(403).json({
          error: "Your geofencing location is not mapped yet",
          notConfigured: true,
          details: geoCheck.message || "Please contact admin to configure your zone boundaries.",
        });
      }
      return res.status(403).json({
        error: "Out of Zone",
        notConfigured: false,
        details: geoCheck.message || "You are outside the allowed geo-fence zone.",
      });
    }

    const updated = await processPunch(
      attendance.attendance_id,
      punchType,
      req.file,
      userId,
      locationPayload,
      {
        employeeId: empId,
        requireFaceMatch: true,
        faceMatchThreshold: matchThreshold,
      }
    );

    trackSuccessfulAttendanceEvent({
      cityId: livenessTrackingCityId,
      source: "individual_attendance",
      metricDate: attendanceDate,
      attendanceCount: 1,
    });

    return res.json({
      success: true,
      mode: "single",
      liveness: {
        faceCount: faces.length,
        brightness,
        sharpness,
        confidence,
        pose,
      },
      employee: employeeRecord.name,
      punch_type: punchType,
      face_similarity: updated.face_similarity ?? null,
      face_match_threshold: updated.face_match_threshold ?? matchThreshold,
      attendance_id: attendance.attendance_id,
      time: formatPunchTimeForClient(resolvePunchRecordTime(updated, punchType)),
    });
  } catch (error) {
    console.error("Face liveness error:", error);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    const { status, payload } = mapRekognitionError(error);
    res.status(status).json(payload);
  }
});

router.get("/self/status", authenticate, async (req, res) => {
  try {
    await ensureSelfAttendanceSupport();
    const resolved = await resolveEmployeeForUser(req.user);

    if (!resolved) {
      return res
        .status(404)
        .json({ error: "Employee profile not found for this user" });
    }

    const attendanceDate = resolveAttendanceDate(req.query);
    const attendance = await getOrCreateAttendanceRecord(
      resolved.employee.emp_id,
      attendanceDate
    );

    const attendancePayload = attendance
      ? {
        attendance_id: attendance.attendance_id,
        date: attendance.date,
        punch_in_time: attendance.punch_in_time,
        mid_shift_punch_in_time: attendance.mid_shift_punch_in_time,
        punch_out_time: attendance.punch_out_time,
        punch_in_image: attendance.punch_in_image,
        mid_shift_punch_in_image: attendance.mid_shift_punch_in_image,
        punch_out_image: attendance.punch_out_image,
        ward_id: attendance.ward_id,
      }
      : null;

    return res.json({
      success: true,
      employee: {
        emp_id: resolved.employee.emp_id,
        emp_code: resolved.employee.emp_code,
        name: resolved.employee.name,
        phone: resolved.employee.phone,
        ward_id: resolved.employee.ward_id,
        face_enrolled: Boolean(resolved.employee.face_embedding),
        self_attendance_enabled: Boolean(
          resolved.employee.self_attendance_enabled
        ),
      },
      attendance: attendancePayload,
    });
  } catch (error) {
    console.error("Self attendance status error:", error);
    res.status(500).json({ error: "Unable to fetch self attendance status" });
  }
});

router.get("/self/calendar", authenticate, async (req, res) => {
  try {
    await ensureSelfAttendanceSupport();
    const resolved = await resolveEmployeeForUser(req.user);

    if (!resolved) {
      return res
        .status(404)
        .json({ error: "Employee profile not found for this user" });
    }

    const { startDate, endDate, month } = resolveMonthRange(req.query.month);

    const recordsQuery = `
      WITH date_series AS (
        SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day
      )
      SELECT
        ds.day AS attendance_date,
        TO_CHAR(ds.day, 'YYYY-MM-DD') AS attendance_date_iso,
        TO_CHAR(ds.day, 'DD Mon') AS attendance_date_label,
        a.attendance_id,
        a.punch_in_time,
        a.mid_shift_punch_in_time,
        a.punch_out_time,
        TO_CHAR((a.punch_in_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS punch_in_display,
        TO_CHAR((a.mid_shift_punch_in_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS mid_shift_punch_in_display,
        TO_CHAR((a.punch_out_time AT TIME ZONE 'Asia/Kolkata'), 'HH12:MI AM') AS punch_out_display,
        CASE
          WHEN a.punch_in_time IS NOT NULL AND a.punch_out_time IS NOT NULL THEN 'Marked'
          WHEN a.punch_in_time IS NOT NULL THEN 'In Progress'
          ELSE 'Not Marked'
        END AS attendance_status
      FROM date_series ds
      LEFT JOIN attendance a
        ON a.emp_id = $1
       AND a.date::date = ds.day
      ORDER BY ds.day ASC;
    `;

    const { rows } = await pool.query(recordsQuery, [
      resolved.employee.emp_id,
      startDate,
      endDate,
    ]);

    const records = rows.map((row) => ({
      date: row.attendance_date_iso,
      dateLabel: row.attendance_date_label,
      attendanceId: row.attendance_id ?? null,
      punchInDisplay: row.punch_in_display || null,
      midShiftPunchInDisplay: row.mid_shift_punch_in_display || null,
      punchOutDisplay: row.punch_out_display || null,
      status: row.attendance_status || "Not Marked",
      hasPunchIn: Boolean(row.punch_in_time),
      hasPunchOut: Boolean(row.punch_out_time),
    }));

    const stats = records.reduce(
      (acc, record) => {
        acc.totalDays += 1;
        if (record.status === "Marked") {
          acc.markedDays += 1;
        } else if (record.status === "In Progress") {
          acc.inProgressDays += 1;
        } else {
          acc.notMarkedDays += 1;
        }
        return acc;
      },
      { totalDays: 0, markedDays: 0, inProgressDays: 0, notMarkedDays: 0 }
    );

    res.json({
      success: true,
      month,
      range: { startDate, endDate },
      employee: {
        emp_id: resolved.employee.emp_id,
        emp_code: resolved.employee.emp_code,
        name: resolved.employee.name,
      },
      stats,
      records,
    });
  } catch (error) {
    console.error("Self attendance calendar error:", error);
    res.status(500).json({ error: "Unable to fetch self attendance calendar" });
  }
});

router.post("/self/onboard", authenticate, async (req, res) => {
  try {
    const actorRole = (req.user?.role || "").toLowerCase();
    if (actorRole !== "supervisor" && actorRole !== "admin") {
      return res
        .status(403)
        .json({ error: "Only supervisors or admins can enable self punch" });
    }

    const { employeeId, email, password, phone } = req.body || {};
    const normalizedEmpId = normalizeId(employeeId);
    if (!normalizedEmpId || !email || !password) {
      return res.status(400).json({
        error: "employeeId, email, and password are required",
      });
    }

    await ensureSelfAttendanceSupport();
    const employee = await fetchEmployeeById(normalizedEmpId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    if (!employee.emp_code) {
      return res.status(412).json({
        error: "Employee code is required to enable self punch",
      });
    }

    if (!employee.face_embedding) {
      return res.status(412).json({
        error: "Store the employee face before enabling self punch",
      });
    }

    const normalizedEmail = email.toString().trim().toLowerCase();
    const hashedPassword = await bcrypt.hash(password.toString(), 10);

    const existingUser = await pool.query(
      `
        SELECT user_id, role
          FROM users
         WHERE email = $1
            OR emp_code = $2
         LIMIT 1
      `,
      [normalizedEmail, employee.emp_code]
    );

    let userRecord = null;
    if (existingUser.rows.length) {
      const updated = await pool.query(
        `
          UPDATE users
             SET name = $2,
                 emp_code = $3,
                 email = $4,
                 phone = COALESCE($5, phone),
                 role = 'user',
                 password_hash = $6
           WHERE user_id = $1
       RETURNING user_id, email, emp_code, role, name, phone
        `,
        [
          existingUser.rows[0].user_id,
          employee.name,
          employee.emp_code,
          normalizedEmail,
          phone || employee.phone || null,
          hashedPassword,
        ]
      );
      userRecord = updated.rows[0];
    } else {
      const created = await pool.query(
        `
          INSERT INTO users (name, emp_code, email, phone, role, password_hash)
          VALUES ($1, $2, $3, $4, 'user', $5)
          RETURNING user_id, email, emp_code, role, name, phone
        `,
        [
          employee.name,
          employee.emp_code,
          normalizedEmail,
          phone || employee.phone || null,
          hashedPassword,
        ]
      );
      userRecord = created.rows[0];
    }

    try {
      await pool.query(
        `
          INSERT INTO roles (name, description, is_system)
          VALUES ('employee', 'Employee self-attendance role', TRUE)
          ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
        `
      );
    } catch (roleError) {
      console.warn("ensureEmployeeRole inline failed:", roleError?.message || roleError);
    }

    try {
      await pool.query(
        `
          INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
          SELECT $1, id, NOW(), $2 FROM roles WHERE name = 'employee'
          ON CONFLICT DO NOTHING
        `,
        [userRecord.user_id, req.user?.user_id ?? null]
      );
    } catch (userRoleError) {
      console.warn("assign employee role failed:", userRoleError?.message || userRoleError);
    }

    await pool.query(
      `
        UPDATE employee
           SET self_attendance_enabled = TRUE
         WHERE emp_id = $1
      `,
      [employee.emp_id]
    );

    res.json({
      success: true,
      message: "Employee self punch enabled",
      user: userRecord,
      employee: {
        emp_id: employee.emp_id,
        emp_code: employee.emp_code,
        name: employee.name,
        self_attendance_enabled: true,
      },
    });
  } catch (error) {
    console.error("Self onboard error:", error);
    if (error?.code === "23505") {
      return res.status(409).json({
        error: "Email or employee code already exists",
      });
    }
    if (error?.code === "23502") {
      return res.status(400).json({
        error: "Missing required user fields",
      });
    }
    res.status(500).json({ error: "Unable to enable self punch" });
  }
});

router.post("/self/disable", authenticate, async (req, res) => {
  try {
    const actorRole = (req.user?.role || "").toLowerCase();
    if (actorRole !== "supervisor" && actorRole !== "admin") {
      return res
        .status(403)
        .json({ error: "Only supervisors or admins can disable self punch" });
    }

    const { employeeId } = req.body || {};
    const normalizedEmpId = normalizeId(employeeId);
    if (!normalizedEmpId) {
      return res.status(400).json({ error: "employeeId is required" });
    }

    await ensureSelfAttendanceSupport();
    const employee = await fetchEmployeeById(normalizedEmpId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    await pool.query(
      `
        UPDATE employee
           SET self_attendance_enabled = FALSE
         WHERE emp_id = $1
      `,
      [employee.emp_id]
    );

    res.json({
      success: true,
      message: "Self punch disabled for employee",
      employee: {
        emp_id: employee.emp_id,
        emp_code: employee.emp_code,
        name: employee.name,
        self_attendance_enabled: false,
      },
    });
  } catch (error) {
    console.error("Self disable error:", error);
    res.status(500).json({ error: "Unable to disable self punch" });
  }
});

router.post("/self/punch", authenticate, upload.single("image"), async (req, res) => {
  try {
    await ensureSelfAttendanceSupport();
    const resolved = await resolveEmployeeForUser(req.user);
    if (!resolved) {
      return res
        .status(404)
        .json({ error: "Employee profile not found for this user" });
    }

    if (!resolved.employee.self_attendance_enabled) {
      return res
        .status(403)
        .json({ error: "Self punch is not enabled for this employee" });
    }

    if (!resolved.employee.face_embedding) {
      return res.status(412).json({
        error: "Store the employee face before marking self attendance",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Face image is required" });
    }

    await ensureNormalizedCaptureFile(req.file);

    const punchType = normalizePunchType(req.body?.punch_type);

    const attendanceDate = resolveAttendanceDate(req.body, req.query);

    // ?? Session-aware validation (prevents re-punch-in + night shift support)
    const sessionError = await validatePunchSession(resolved.employee.emp_id, attendanceDate, punchType);
    if (sessionError) {
      return res.status(sessionError.status).json({
        error: sessionError.error,
        code: sessionError.code,
      });
    }

    // Resolve or create attendance record (handles night-shift carry-forward)
    const attendance = await getOrCreateAttendanceRecord(
      resolved.employee.emp_id,
      attendanceDate,
      { punchType, createIfMissing: true }
    );

    // ?? Geofencing Validation
    const geoCheck = await validateGeofencing(
      resolved.employee.emp_id,
      req.body.latitude,
      req.body.longitude
    );
    if (!geoCheck.allowed) {
      if (geoCheck.notConfigured) {
        return res.status(403).json({
          error: "Your geofencing location is not mapped yet",
          notConfigured: true,
          details:
            geoCheck.message ||
            "Please contact admin to configure your zone boundaries.",
        });
      }
      return res.status(403).json({
        error: "Out of Zone",
        notConfigured: false,
        details:
          geoCheck.message || "You are outside the allowed geo-fence zone.",
      });
    }

    const updated = await processPunch(
      attendance.attendance_id,
      punchType,
      req.file,
      req.user?.user_id,
      {
        latitude: req.body.latitude ?? "0",
        longitude: req.body.longitude ?? "0",
        address: req.body.address ?? "",
      },
      {
        employeeId: resolved.employee.emp_id,
        requireFaceMatch: true,
      }
    );

    const selfPunchCityId = await resolveRequestCityId({ employeeId: resolved.employee.emp_id });
    trackSuccessfulAttendanceEvent({
      cityId: selfPunchCityId,
      source: "individual_attendance",
      metricDate: attendanceDate,
      attendanceCount: 1,
    });

    res.json({
      success: true,
      attendance_id: attendance.attendance_id,
      punch_type: punchType,
      face_similarity: updated.face_similarity ?? null,
      face_match_threshold: updated.face_match_threshold ?? null,
      time: formatPunchTimeForClient(resolvePunchRecordTime(updated, punchType)),
    });
  } catch (error) {
    console.error("Self punch error:", error);
    safeDebugLog(`[${new Date().toISOString()}] Self Punch Error: ${error?.stack || error}`);
    if (error.statusCode) {
      return res
        .status(error.statusCode)
        .json({ error: error.message, details: error.details });
    }
    res.status(500).json({ error: "Unable to process self punch" });
  }
});

// Mark leave (CASUAL / MEDICAL), allows future dates, no cancellation here
router.post("/mark-leave", authenticate, async (req, res) => {
  try {
    const user = req.user || {};
    const role = (user.role || "").toLowerCase();
    const empId = Number(req.body.emp_id ?? req.body.employeeId);
    const leaveType = normalizeLeaveInput(req.body.leave_type || req.body.leaveType || "");
    const targetDate = resolveIsoDateInput(req.body.date);

    if (!empId) {
      return res.status(400).json({ error: "emp_id is required" });
    }
    if (!ALLOWED_LEAVE_TYPES.has(leaveType)) {
      return res.status(400).json({
        error: "Invalid leave_type",
        allowed: Array.from(ALLOWED_LEAVE_TYPES),
      });
    }
    if (!role) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // If supervisor, ensure employee is in their wards
    if (role !== "admin") {
      const wardCheck = await pool.query(
        `SELECT 1
         FROM employee e
         LEFT JOIN wards w ON e.ward_id = w.ward_id
         WHERE e.emp_id = $2 AND (
           EXISTS (
             SELECT 1 FROM supervisor_ward sw
             WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_kothi_access uk
             WHERE uk.ward_id = e.ward_id AND uk.user_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM supervisor_kothi sk
             WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_zone_access uz
             WHERE uz.zone_id = w.zone_id AND uz.user_id = $1
           )
         ) LIMIT 1`,
        [user.user_id, empId]
      );
      if (wardCheck.rowCount === 0) {
        return res.status(403).json({ error: "Employee not assigned to this supervisor." });
      }
    }

    const existing = await pool.query(
      `SELECT attendance_id, punch_in_time, punch_out_time, leave_type
       FROM attendance WHERE emp_id = $1 AND date = $2 LIMIT 1`,
      [empId, targetDate]
    );

    const row = existing.rows[0];
    if (row?.punch_in_time) {
      return res.status(409).json({ error: "Attendance already punched for this date." });
    }
    if (row?.leave_type) {
      return res.status(200).json({ success: true, attendance_id: row.attendance_id, leave_type: row.leave_type });
    }

    // fetch ward / zone / city so we never insert null ward_id
    const empMetaResult = await pool.query(
      `SELECT e.emp_id, e.ward_id
       FROM employee e
       WHERE e.emp_id = $1
       LIMIT 1`,
      [empId]
    );
    const empMeta = empMetaResult.rows[0];
    if (!empMeta) {
      return res.status(404).json({ error: "Employee not found" });
    }
    if (!empMeta.ward_id) {
      return res
        .status(400)
        .json({ error: "Employee is missing ward assignment." });
    }

    let result;
    if (row) {
      result = await pool.query(
        `UPDATE attendance
         SET leave_type = $1,
             leave_marked_by = $2,
             leave_marked_at = NOW(),
             punch_in_time = NULL,
             punch_out_time = NULL,
             ward_id = COALESCE(ward_id, $4)
         WHERE attendance_id = $3
         RETURNING *`,
        [leaveType, user.user_id || null, row.attendance_id, empMeta.ward_id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO attendance (emp_id, ward_id, date, leave_type, leave_marked_by, leave_marked_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [empId, empMeta.ward_id, targetDate, leaveType, user.user_id || null]
      );
    }

    res.json({ success: true, attendance: result.rows[0] });
  } catch (error) {
    console.error("Mark leave error:", error);
    res.status(500).json({
      error: "Unable to mark leave",
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
    });
  }
});

router.post("/unmark-leave", authenticate, async (req, res) => {
  try {
    const user = req.user || {};
    const role = (user.role || "").toLowerCase();
    const empId = Number(req.body.emp_id ?? req.body.employeeId);
    const targetDate = resolveIsoDateInput(req.body.date);

    if (!empId) {
      return res.status(400).json({ error: "emp_id is required" });
    }

    if (role !== "admin") {
      const wardCheck = await pool.query(
        `SELECT 1
         FROM employee e
         LEFT JOIN wards w ON e.ward_id = w.ward_id
         WHERE e.emp_id = $2 AND (
           EXISTS (
             SELECT 1 FROM supervisor_ward sw
             WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_kothi_access uk
             WHERE uk.ward_id = e.ward_id AND uk.user_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM supervisor_kothi sk
             WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_zone_access uz
             WHERE uz.zone_id = w.zone_id AND uz.user_id = $1
           )
         ) LIMIT 1`,
        [user.user_id, empId]
      );
      if (wardCheck.rowCount === 0) {
        return res.status(403).json({ error: "Employee not assigned to this supervisor." });
      }
    }

    const result = await pool.query(
      `UPDATE attendance
       SET leave_type = NULL,
           leave_marked_by = NULL,
           leave_marked_at = NULL
       WHERE emp_id = $1 AND date = $2::date
       RETURNING *`,
      [empId, targetDate]
    );

    res.json({ success: true, attendance: result.rows[0] });
  } catch (error) {
    console.error("Unmark leave error:", error);
    res.status(500).json({ error: "Unable to unmark leave", message: error.message });
  }
});

module.exports = router;
