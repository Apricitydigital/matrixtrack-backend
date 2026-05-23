const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const pool = require("../../config/db");
const multer = require("multer");
const {
  uploadAttendanceImage,
  isLocalImage,
  getLocalImagePath,
  isS3Image,
  extractS3Key,
  getS3ImageStream,
} = require("../../utils/s3Storage");
const {
  buildAttendanceImagePath,
  getAttendanceUploadContext,
} = require("../../utils/attendanceKeyBuilder");
const {
  rekognition,
  DetectFacesCommand,
  SearchFacesByImageCommand,
} = require("../../config/awsConfig");

const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? "97") || 97;
const isGroupModeRequest = (...values) =>
  values.some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    const s = v.toString().trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes") return true;
    const c = s.replace(/[^a-z]/g, "");
    return ["group", "groupmode", "groupattendance", "bulk", "multi"].includes(c);
  });

// Set up Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Fetch or create attendance record for an employee
router.post("/", async (req, res) => {
  const { emp_id } = req.body;
  const today = new Date().toISOString().split("T")[0]; // Format YYYY-MM-DD
  const attendanceDate = today;

  if (!emp_id) {
    return res.status(400).json({ error: "Employee ID is required" });
  }

  try {
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
      [emp_id, attendanceDate]
    );

    let attendance;

    const wardDetail = await pool.query(
      `SELECT ward_id from employee e where e.emp_id = $1`,
      [emp_id]
    );
    let ward_id;
    if (wardDetail.rows.length > 0) {
      ward_id = wardDetail.rows[0].ward_id;
    }

    if (result.rows.length > 0) {
      // Attendance record found
      attendance = result.rows[0];
    } else {
      // Create a new attendance record
      const insertResult = await pool.query(
        `INSERT INTO attendance (emp_id, date, ward_id)
         VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (emp_id, date) DO NOTHING
         RETURNING attendance_id, date, ward_id`,
        [emp_id, ward_id]
      );

      if (insertResult.rowCount === 0) {
        console.warn("Record exists, skipping");
      }

      const baseAttendance =
        insertResult.rows[0] ||
        (
          await pool.query(
            `SELECT attendance_id, date, ward_id FROM attendance WHERE emp_id = $1 AND date = CURRENT_DATE LIMIT 1`,
            [emp_id]
          )
        ).rows[0];

      if (!baseAttendance) {
        console.warn("Record exists, skipping");
        return res
          .status(200)
          .json({ message: "Record exists, skipping", emp_id });
      }

      attendance = {
        attendance_id: baseAttendance.attendance_id,
        date: attendanceDate,
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
        emp_code: null, // Fetching separately
        employee_name: null,
        designation_name: null,
        ward_id: baseAttendance.ward_id,
        ward_name: null,
      };

      // Fetch employee details
      const empDetails = await pool.query(
        `SELECT emp_code, name AS employee_name, d.designation_name, w.ward_id, w.ward_name
         FROM employee e
         JOIN designation d ON e.designation_id = d.designation_id
         JOIN wards w ON e.ward_id = w.ward_id
         WHERE e.emp_id = $1`,
        [emp_id]
      );

      if (empDetails.rows.length > 0) {
        Object.assign(attendance, empDetails.rows[0]);
      }
    }
    res.json(attendance);
  } catch (error) {
    console.error("Error fetching attendance record: ", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// PUT Route - Now using multipart/form-data
router.put("/", upload.single("image"), async (req, res) => {
  const { attendance_id, punch_type, latitude, longitude, address } = req.body;

  if (!attendance_id || !punch_type || !latitude || !longitude || !address) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const normalizedPunchType = (punch_type || "").toString().trim().toUpperCase();
  const punchType = normalizedPunchType === "OUT" ? "OUT" : "IN";

  try {
    // Fetch record to get emp_id and date
    const attendanceResult = await pool.query(
      `SELECT emp_id, date, punch_in_time, punch_out_time FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (attendanceResult.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    const { emp_id, date: recordDate, punch_in_time, punch_out_time } = attendanceResult.rows[0];

    // 🔒 SESSION-AWARE VALIDATION — prevents re-punch-in after punch-out
    if (punchType === "IN") {
      // Block if already punched in (open session)
      const openSession = await pool.query(
        `SELECT attendance_id FROM attendance
         WHERE emp_id = $1
           AND date >= ($2::date - INTERVAL '1 day')
           AND date <= $2::date
           AND punch_in_time IS NOT NULL
           AND punch_out_time IS NULL
         LIMIT 1`,
        [emp_id, recordDate]
      );
      if (openSession.rows.length > 0) {
        return res.status(400).json({
          error: "Aap abhi bhi punched in hain. Pehle punch out karein.",
          code: "ALREADY_PUNCHED_IN",
        });
      }

      // Block if today's session already completed (punch-in + punch-out both done)
      const closedSession = await pool.query(
        `SELECT attendance_id FROM attendance
         WHERE emp_id = $1
           AND date >= ($2::date - INTERVAL '1 day')
           AND date <= $2::date
           AND punch_in_time IS NOT NULL
           AND punch_out_time IS NOT NULL
         LIMIT 1`,
        [emp_id, recordDate]
      );
      if (closedSession.rows.length > 0) {
        return res.status(400).json({
          error: "Aapka aaj ka attendance pehle se complete ho chuka hai.",
          code: "SESSION_ALREADY_COMPLETE",
        });
      }
    }

    if (punchType === "OUT") {
      // For punch-out: find the open session (handles night-shift carry-forward)
      const openSession = await pool.query(
        `SELECT attendance_id FROM attendance
         WHERE emp_id = $1
           AND date >= ($2::date - INTERVAL '1 day')
           AND date <= $2::date
           AND punch_in_time IS NOT NULL
           AND punch_out_time IS NULL
         LIMIT 1`,
        [emp_id, recordDate]
      );
      if (openSession.rows.length === 0) {
        return res.status(400).json({
          error: "Punch-in First",
          code: "NOT_PUNCHED_IN",
        });
      }
    }

    let imageUrl = null;

    // Upload image directly as binary if provided
    if (req.file) {
      const uploadContext = await getAttendanceUploadContext(pool, attendance_id);
      // Upload the raw buffer directly without base64 conversion
      const uploadResult = await uploadAttendanceImage(
        req.file.buffer, // Direct binary buffer
        buildAttendanceImagePath({
          attendanceDate: uploadContext?.attendance_date,
          punchType:
            punchType === "IN"
              ? "punch-in"
              : punchType === "OUT"
                ? "punch-out"
                : punchType,
          empCode: uploadContext?.emp_code,
          empId: uploadContext?.emp_id,
          employeeName: uploadContext?.employee_name,
          wardName: uploadContext?.ward_name,
          zoneName: uploadContext?.zone_name,
          cityName: uploadContext?.city_name,
          address,
          latitude,
          longitude,
          capturedAt: new Date(),
        })
      );
      imageUrl = uploadResult?.url ?? null;
    }

    // Update attendance record
    const updateQuery =
      punchType === "IN"
        ? `UPDATE attendance SET 
          punch_in_time = NOW(),
          latitude_in = $1, 
          longitude_in = $2, 
          in_address = $3, 
          punch_in_image = $4
         WHERE attendance_id = $5 RETURNING *`
        : `UPDATE attendance SET 
          punch_out_time = NOW(),
          latitude_out = $1, 
          longitude_out = $2, 
          out_address = $3, 
          punch_out_image = $4
         WHERE attendance_id = $5 RETURNING *`;

    const updateValues = [
      latitude,
      longitude,
      address,
      imageUrl,
      attendance_id,
    ];
    const result = await pool.query(updateQuery, updateValues);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Attendance update failed" });
    }

    res.json({
      message: `Punch ${punchType} updated successfully`,
      attendance: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating attendance:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Route to get attendance image - Optimized version
router.get("/image", async (req, res) => {
  const { attendance_id, punch_type } = req.query;

  if (!attendance_id || !punch_type) {
    return res.status(400).json({ error: "Missing required query parameters" });
  }

  try {
    const imageColumn =
      punch_type.toUpperCase() === "IN" ? "punch_in_image" : "punch_out_image";

    // Fetch image URL from the database
    const result = await pool.query(
      `SELECT ${imageColumn} AS image_url FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (result.rows.length === 0 || !result.rows[0].image_url) {
      return res.status(404).json({ error: "Image not found" });
    }

    const imageUrl = result.rows[0].image_url;
    let downloadName = `attendance_${attendance_id}_${punch_type}.jpg`;
    if (isS3Image(imageUrl)) {
      const key = extractS3Key(imageUrl);
      if (key) {
        downloadName = path.basename(key);
      }
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

// Mark attendance with only photo — supports group mode with 10-person limit
router.post(
  "/face-attendance",
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        punch_type,
        groupMode,
        group_mode: groupModeAlias,
        mode: rawMode,
      } = req.body;

      if (!req.file) {
        return res.status(400).json({ error: "Face image is required" });
      }

      const imageBuffer = req.file.buffer;
      const collectionId =
        (process.env.REKOGNITION_COLLECTION || "").trim() ||
        (process.env.REKOGNITION_COLLECTION_ID || "").trim() ||
        null;

      if (!collectionId) {
        return res.status(500).json({ error: "Rekognition collection is not configured" });
      }

      const groupModeRequested = isGroupModeRequest(groupMode, groupModeAlias, rawMode);
      console.log("[face-attendance-old] groupMode:", groupMode, "| mode:", rawMode, "| groupModeRequested:", groupModeRequested);

      // ─── GROUP MODE: detect all faces, enforce 10-person limit ───────────────
      if (groupModeRequested) {
        const detectResult = await rekognition.send(
          new DetectFacesCommand({
            Image: { Bytes: imageBuffer },
            Attributes: ["DEFAULT"],
          })
        );
        const faceDetails = detectResult?.FaceDetails ?? [];
        console.log("[face-attendance-old] Detected faces:", faceDetails.length);

        if (!faceDetails.length) {
          return res.status(422).json({
            error: "No faces detected in the image",
            suggestion: "Ensure group members are clearly visible and retry.",
          });
        }

        if (faceDetails.length > GROUP_LIMIT) {
          console.log("[face-attendance-old] BLOCKING: too many faces:", faceDetails.length);
          return res.status(422).json({
            error: "Please reduce the people count to 10",
            details: `Detected ${faceDetails.length} faces. Maximum allowed is ${GROUP_LIMIT}.`,
            suggestion: `Capture the photo with ${GROUP_LIMIT} or fewer people and retry.`,
          });
        }

        // Process each face individually
        const results = [];
        const processedEmpIds = new Set();

        for (let i = 0; i < faceDetails.length; i++) {
          try {
            const searchResult = await rekognition.send(
              new SearchFacesByImageCommand({
                CollectionId: collectionId,
                Image: { Bytes: imageBuffer },
                MaxFaces: 1,
                FaceMatchThreshold: FACE_MATCH_THRESHOLD,
              })
            );

            const bestMatch = searchResult.FaceMatches?.[0];
            if (!bestMatch?.Face) {
              results.push({ faceIndex: i + 1, status: "unmatched", message: "No matching employee found." });
              continue;
            }

            const faceId = bestMatch.Face.FaceId;
            const similarity = bestMatch.Similarity ?? null;
            const { rows } = await pool.query(
              "SELECT emp_id, name FROM employee WHERE face_id = $1",
              [faceId]
            );

            if (!rows.length) {
              results.push({ faceIndex: i + 1, status: "unmatched", similarity, message: "Face not linked to any employee." });
              continue;
            }

            const emp = rows[0];
            if (processedEmpIds.has(emp.emp_id)) {
              results.push({ faceIndex: i + 1, status: "duplicate", employeeId: emp.emp_id, employeeName: emp.name, similarity });
              continue;
            }

            processedEmpIds.add(emp.emp_id);
            results.push({ faceIndex: i + 1, status: "punched", employeeId: emp.emp_id, employeeName: emp.name, similarity });
          } catch (searchErr) {
            console.error("Group face search error:", searchErr);
            results.push({ faceIndex: i + 1, status: "error", message: "Face recognition failed" });
          }
        }

        const punchedCount = results.filter((r) => r.status === "punched").length;
        return res.json({
          success: punchedCount > 0,
          mode: "group",
          punch_type,
          total_faces: faceDetails.length,
          punched_count: punchedCount,
          results,
        });
      }

      // ─── SINGLE FACE MODE ────────────────────────────────────────────────────
      const searchResult = await rekognition.send(
        new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: imageBuffer },
          MaxFaces: 1,
          FaceMatchThreshold: FACE_MATCH_THRESHOLD,
        })
      );

      if (!searchResult.FaceMatches?.length) {
        return res.status(401).json({
          error: "No matching employee found",
          suggestion: "Use manual attendance if face recognition fails",
        });
      }

      const faceId = searchResult.FaceMatches[0].Face.FaceId;
      const { rows } = await pool.query(
        "SELECT emp_id FROM employee WHERE face_id = $1",
        [faceId]
      );

      if (!rows.length) {
        return res.status(404).json({
          error: "Employee not registered in system",
          solution: "Register face first via /store-face",
        });
      }

      res.json({
        success: true,
        punch_type,
        emp_id: rows[0].emp_id,
      });
    } catch (error) {
      console.error("Face attendance error:", error);
      res.status(500).json({
        error: "Try manual attendance if this persists",
        fallback_route: "POST /attendance",
      });
    }
  }
);

module.exports = router;
