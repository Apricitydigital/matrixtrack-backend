const express = require("express");
const axios = require("axios");
const router = express.Router();
const pool = require("../../config/db");
const multer = require("multer");
const fs = require("fs");
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
  rekognition,
  CreateCollectionCommand,
  CompareFacesCommand,
  SearchFacesByImageCommand,
  DetectFacesCommand,
} = require("../../config/awsConfig");

// Constants
const PUNCH_TYPES = {
  IN: "IN",
  OUT: "OUT",
};

// Set up Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

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

async function resolveEmployeeFromFaceIdentifiers({
  faceId = null,
  matchedExternalId = null,
  requestedEmpId = null,
}) {
  const tryResolveByEmpId = async (empId) => {
    if (empId === null) {
      return null;
    }

    const { rows } = await pool.query(
      "SELECT emp_id, name FROM employee WHERE emp_id = $1",
      [empId]
    );

    return rows.length ? rows[0] : null;
  };

  let employeeRecord = null;

  if (faceId) {
    const { rows } = await pool.query(
      "SELECT emp_id, name FROM employee WHERE face_id = $1",
      [faceId]
    );

    if (rows.length) {
      return rows[0];
    }
  }

  if (!employeeRecord && matchedExternalId !== null) {
    employeeRecord = await tryResolveByEmpId(matchedExternalId);
  }

  if (!employeeRecord && requestedEmpId !== null) {
    employeeRecord = await tryResolveByEmpId(requestedEmpId);
  }

  if (employeeRecord && faceId) {
    try {
      await pool.query(
        `UPDATE employee
           SET face_id = $1
         WHERE emp_id = $2
           AND (face_id IS NULL OR face_id <> $1)`,
        [faceId, employeeRecord.emp_id]
      );
    } catch (error) {
      console.error("resolveEmployeeFromFaceIdentifiers:update face_id failed", error);
    }
  }

  return employeeRecord;
}

function validatePunchAttempt(attendance, punchType) {
  if (!attendance) {
    return {
      status: 404,
      error: "Attendance record not found",
    };
  }

  if (punchType === PUNCH_TYPES.IN && attendance.punch_in_time) {
    return {
      status: 400,
      error: "Already punched in today",
    };
  }

  if (punchType === PUNCH_TYPES.OUT && attendance.punch_out_time) {
    return {
      status: 400,
      error: "Already punched out today",
    };
  }

  if (punchType === PUNCH_TYPES.OUT && !attendance.punch_in_time) {
    return {
      status: 400,
      error: "Must punch in first",
    };
  }

  return null;
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
const parsedFaceThreshold = Number(process.env.FACE_MATCH_THRESHOLD ?? "90");
const DEFAULT_FACE_MATCH_THRESHOLD = Number.isFinite(parsedFaceThreshold)
  ? parsedFaceThreshold
  : 90;

// Utility functions
function formatDate(date = new Date()) {
  const working = new Date(date.getTime());
  const offsetMinutes = working.getTimezoneOffset();
  return new Date(working.getTime() - offsetMinutes * 60 * 1000)
    .toISOString()
    .split("T")[0];
}

async function getOrCreateAttendanceRecord(emp_id, date) {
  if (!emp_id) throw new Error("Employee ID is required");

  // Check if attendance record exists
  const result = await pool.query(
    `SELECT a.attendance_id, CAST(a.date AS VARCHAR) AS date, 
            TO_CHAR(a.punch_in_time, 'HH12:MI AM') AS punch_in_time, 
            TO_CHAR(a.punch_out_time, 'HH12:MI AM') AS punch_out_time, 
            a.duration, a.punch_in_image, a.punch_out_image, 
            a.latitude_in, a.longitude_in, a.in_address, 
            a.latitude_out, a.longitude_out, a.out_address,
            e.emp_id, e.emp_code, e.name AS employee_name, 
            d.designation_name, w.ward_id, w.ward_name
     FROM attendance a
     JOIN employee e ON a.emp_id = e.emp_id
     JOIN designation d ON e.designation_id = d.designation_id
     JOIN wards w ON e.ward_id = w.ward_id
     WHERE a.emp_id = $1 AND a.date = $2`,
    [emp_id, date]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  const wardDetail = await pool.query(
    `SELECT ward_id from employee e where e.emp_id = $1`,
    [emp_id]
  );
  let ward_id;
  if (wardDetail.rows.length > 0) {
    ward_id = wardDetail.rows[0].ward_id;
  }

  // Create new record if not exists
  const insertResult = await pool.query(
    `INSERT INTO attendance (emp_id, date, ward_id) 
     VALUES ($1, $2::date, $3) 
     RETURNING attendance_id, date, ward_id`,
    [emp_id, date, ward_id]
  );

  const attendance = {
    attendance_id: insertResult.rows[0].attendance_id,
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
    ward_id: insertResult.rows[0].ward_id,
    ward_name: null,
  };

  // Fetch employee details
  const empDetails = await pool.query(
    `SELECT emp_code, name AS employee_name, d.designation_name, w.ward_name
     FROM employee e
     JOIN designation d ON e.designation_id = d.designation_id
     JOIN wards w ON e.ward_id = w.ward_id
     WHERE e.emp_id = $1`,
    [emp_id]
  );

  if (empDetails.rows.length > 0) {
    Object.assign(attendance, empDetails.rows[0]);
  }

  return attendance;
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
  } = options;

  let uploadResult = null;
  if (imageFile) {
    uploadResult = await uploadAttendanceImage(
      imageFile.buffer,
      `attendance_${attendanceId}_${punchType}.jpg`
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

  const isPunchIn = punchType === PUNCH_TYPES.IN;
  const updateQuery = `
    UPDATE attendance SET 
      ${isPunchIn ? "punch_in_time" : "punch_out_time"} = NOW(),
      ${isPunchIn ? "latitude_in" : "latitude_out"} = $1,
      ${isPunchIn ? "longitude_in" : "longitude_out"} = $2,
      ${isPunchIn ? "in_address" : "out_address"} = $3,
      ${isPunchIn ? "punch_in_image" : "punch_out_image"} = $4,
      ${isPunchIn ? "punched_in_by" : "punched_out_by"} = $5
    WHERE attendance_id = $6
    RETURNING *
  `;

  const result = await pool.query(updateQuery, [
    locationData.latitude,
    locationData.longitude,
    locationData.address,
    imageUrl,
    await resolvePunchActor(userId),
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

async function resolvePunchActor(rawUserId) {
  const normalized = normalizeId(rawUserId);
  if (normalized === null) {
    return null;
  }

  try {
    const { rows } = await pool.query(
      "SELECT user_id FROM users WHERE user_id = $1",
      [normalized]
    );

    if (rows.length > 0) {
      return normalized;
    }
  } catch (error) {
    console.error("resolvePunchActor error:", error);
  }

  return null;
}

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
  if (!AWS_S3_BUCKET) {
    console.warn(
      "ensureFaceMatch: AWS_S3_BUCKET not configured; skipping face verification"
    );
    return null;
  }

  if (!employeeId) {
    const err = new Error("Unable to determine employee for attendance record");
    err.statusCode = 400;
    throw err;
  }

  const { rows } = await pool.query(
    "SELECT face_embedding FROM employee WHERE emp_id = $1",
    [employeeId]
  );

  if (!rows.length) {
    const err = new Error("Employee not found for face verification");
    err.statusCode = 404;
    throw err;
  }

  const faceEmbedding = rows[0].face_embedding;
  if (!faceEmbedding) {
    const err = new Error("Employee face enrollment is missing");
    err.statusCode = 412;
    err.details = "Ask the employee to store their face before marking attendance.";
    throw err;
  }

  const faceKey = resolveS3ObjectKey(faceEmbedding);
  if (!faceKey) {
    const err = new Error("Unable to resolve stored face image");
    err.statusCode = 500;
    throw err;
  }

  const compareCommand = new CompareFacesCommand({
    SourceImage: {
      S3Object: {
        Bucket: AWS_S3_BUCKET,
        Name: faceKey,
      },
    },
    TargetImage: {
      S3Object: {
        Bucket: AWS_S3_BUCKET,
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
    err.statusCode = 401;
    err.details = `Similarity ${similarity.toFixed(2)}% below threshold ${threshold}%`;
    throw err;
  }

  return { similarity, threshold };
}

// Routes
router.post("/", async (req, res) => {
  const { emp_id } = req.body;
  const attendanceDate = formatDate();

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

  if (!attendance_id || !punch_type || !latitude || !longitude || !address) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Validate punch conditions
    const attendance = await pool.query(
      `SELECT emp_id, punch_in_time, punch_out_time FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (attendance.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    const { emp_id: attendanceEmpId, punch_in_time, punch_out_time } =
      attendance.rows[0];

    if (punch_type === PUNCH_TYPES.IN && punch_in_time) {
      return res.status(400).json({ error: "Already punched in today" });
    }
    if (punch_type === PUNCH_TYPES.OUT && punch_out_time) {
      return res.status(400).json({ error: "Already punched out today" });
    }
    if (punch_type === PUNCH_TYPES.OUT && !punch_in_time) {
      return res.status(400).json({ error: "Must punch in first" });
    }

    const updated = await processPunch(
      attendance_id,
      punch_type,
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
      message: `Punch ${punch_type} updated successfully`,
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
    const imageColumn =
      punch_type.toUpperCase() === PUNCH_TYPES.IN
        ? "punch_in_image"
        : "punch_out_image";

    const result = await pool.query(
      `SELECT ${imageColumn} AS image_url FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (result.rows.length === 0 || !result.rows[0].image_url) {
      return res.status(404).json({ error: "Image not found" });
    }

    const imageUrl = result.rows[0].image_url;
    const downloadName = `attendance_${attendance_id}_${punch_type}.jpg`;

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
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        error: "Face image is required",
      });
    }

    const collectionId = resolveCollectionId();
    if (!collectionId) {
      return res.status(500).json({
        error: "Rekognition collection is not configured",
        details:
          "Set REKOGNITION_COLLECTION or REKOGNITION_COLLECTION_ID in the backend .env file.",
      });
    }

    await ensureCollectionExists(collectionId);

    const normalizedPunchType = (rawPunchType || "")
      .toString()
      .trim()
      .toUpperCase();
    const punchType =
      normalizedPunchType === PUNCH_TYPES.OUT
        ? PUNCH_TYPES.OUT
        : PUNCH_TYPES.IN;

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

    if (groupModeRequested) {
      const detectCommand = new DetectFacesCommand({
        Image: { Bytes: req.file.buffer },
        Attributes: ["DEFAULT"],
      });

      const detectResult = await rekognition.send(detectCommand);
      const faceDetails = detectResult?.FaceDetails ?? [];

      if (!faceDetails.length) {
        return res.status(422).json({
          error: "No faces detected in the image",
          suggestion: "Ensure group members are clearly visible and retry.",
        });
      }

      const imageMetadata = await sharp(req.file.buffer).metadata();
      const imageWidth = imageMetadata?.width ?? null;
      const imageHeight = imageMetadata?.height ?? null;

      if (!imageWidth || !imageHeight) {
        return res.status(400).json({
          error: "Unable to read image dimensions for face processing",
        });
      }

      const today = formatDate();
      const processedEmployees = new Set();
      const results = [];

      for (let index = 0; index < faceDetails.length; index += 1) {
        const faceDetail = faceDetails[index];
        const faceIndex = index + 1;
        const cropRegion = computeCropRegion(
          faceDetail.BoundingBox,
          imageWidth,
          imageHeight
        );

        if (!cropRegion) {
          results.push({
            faceIndex,
            status: "skipped",
            message: "Unable to crop the detected face region.",
          });
          continue;
        }

        let faceImageBuffer;
        try {
          faceImageBuffer = await sharp(req.file.buffer)
            .extract(cropRegion)
            .resize(600, 600, { fit: "cover" })
            .toBuffer();
        } catch (cropError) {
          console.error("Group attendance: face crop failed", cropError);
          results.push({
            faceIndex,
            status: "error",
            message: "Unable to process the detected face region.",
          });
          continue;
        }

        try {
          const searchResult = await rekognition.send(
            new SearchFacesByImageCommand({
              CollectionId: collectionId,
              Image: { Bytes: faceImageBuffer },
              MaxFaces: 3,
              FaceMatchThreshold: matchThreshold,
            })
          );

          const bestMatch = searchResult.FaceMatches?.[0];
          if (!bestMatch?.Face) {
            results.push({
              faceIndex,
              status: "unmatched",
              similarity: null,
              message: "No matching employee found.",
            });
            continue;
          }

          const similarity = bestMatch.Similarity ?? null;
          const faceId = bestMatch.Face.FaceId;
          const matchedExternalId = normalizeId(
            bestMatch.Face.ExternalImageId
          );
          const employeeRecord = await resolveEmployeeFromFaceIdentifiers({
            faceId,
            matchedExternalId,
            requestedEmpId: null,
          });

          if (!employeeRecord) {
            results.push({
              faceIndex,
              status: "unmatched",
              similarity,
              message: "Matched face is not linked to any employee record.",
            });
            continue;
          }

          if (processedEmployees.has(employeeRecord.emp_id)) {
            results.push({
              faceIndex,
              status: "duplicate",
              similarity,
              employeeId: employeeRecord.emp_id,
              employeeName: employeeRecord.name,
              message: "Employee already processed in this capture.",
            });
            continue;
          }

          const attendance = await getOrCreateAttendanceRecord(
            employeeRecord.emp_id,
            today
          );
          const validation = validatePunchAttempt(attendance, punchType);

          if (validation) {
            results.push({
              faceIndex,
              status: "skipped",
              employeeId: employeeRecord.emp_id,
              employeeName: employeeRecord.name,
              similarity,
              message: validation.error,
            });
            processedEmployees.add(employeeRecord.emp_id);
            continue;
          }

          const updated = await processPunch(
            attendance.attendance_id,
            punchType,
            { buffer: faceImageBuffer },
            userId,
            locationPayload,
            {
              employeeId: employeeRecord.emp_id,
              requireFaceMatch: true,
              faceMatchThreshold: matchThreshold,
            }
          );

          results.push({
            faceIndex,
            status: "punched",
            employeeId: employeeRecord.emp_id,
            employeeName: employeeRecord.name,
            similarity,
            attendanceId: attendance.attendance_id,
            punchedAt:
              punchType === PUNCH_TYPES.IN
                ? updated.punch_in_time
                : updated.punch_out_time,
          });

          processedEmployees.add(employeeRecord.emp_id);
        } catch (searchError) {
          console.error("Group attendance: face search failed", searchError);
          const { payload } = mapRekognitionError(searchError);
          results.push({
            faceIndex,
            status: "error",
            message:
              payload?.details || payload?.error || "Face recognition failed",
          });
        }
      }

      const punchedCount = results.filter(
        (entry) => entry.status === "punched"
      ).length;

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
    const searchParams = {
      CollectionId: collectionId,
      Image: { Bytes: req.file.buffer },
      MaxFaces: 1,
      FaceMatchThreshold: matchThreshold,
    };

    const searchCommand = new SearchFacesByImageCommand(searchParams);
    const searchResult = await rekognition.send(searchCommand);

    if (!searchResult.FaceMatches?.length) {
      return res.status(401).json({
        error: "No matching employee found",
        suggestion: "Use manual attendance if face recognition fails",
      });
    }

    const matchedFace = searchResult.FaceMatches[0]?.Face ?? {};
    const faceId = matchedFace.FaceId;
    const matchedExternalId = normalizeId(matchedFace.ExternalImageId);

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
    const today = formatDate();
    const attendance = await getOrCreateAttendanceRecord(empId, today);

    const validation = validatePunchAttempt(attendance, punchType);
    if (validation) {
      return res.status(validation.status).json({
        error: validation.error,
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

    return res.json({
      success: true,
      employee: employeeRecord.name,
      punch_type: punchType,
      face_similarity: updated.face_similarity ?? null,
      face_match_threshold:
        updated.face_match_threshold ?? matchThreshold,
      time:
        punchType === PUNCH_TYPES.IN
          ? updated.punch_in_time
          : updated.punch_out_time,
    });
  } catch (error) {
    console.error("Face attendance error:", error);

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

module.exports = router;
