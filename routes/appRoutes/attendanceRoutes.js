const express = require("express");
const axios = require("axios");
const fs = require("fs");
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
        `INSERT INTO attendance (emp_id, date, ward_id) VALUES ($1, CURRENT_DATE, $2) RETURNING attendance_id, date`,
        [emp_id, ward_id]
      );

      attendance = {
        attendance_id: insertResult.rows[0].attendance_id,
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
        ward_id: insertResult.rows[0].ward_id,
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

  try {
    // Fetch existing attendance record
    const attendanceResult = await pool.query(
      `SELECT punch_in_time, punch_out_time FROM attendance WHERE attendance_id = $1`,
      [attendance_id]
    );

    if (attendanceResult.rows.length === 0) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    const { punch_in_time, punch_out_time } = attendanceResult.rows[0];

    // Validate punch conditions (keep your existing validation logic)
    if (punch_type === "IN" && punch_in_time) {
      return res
        .status(400)
        .json({ error: "User has already punched in for today." });
    }
    if (punch_type === "OUT" && punch_out_time) {
      return res
        .status(400)
        .json({ error: "User has already punched out for today." });
    }
    if (punch_type === "OUT" && !punch_in_time) {
      return res
        .status(400)
        .json({ error: "User must punch in before punching out." });
    }

    let imageUrl = null;

    // Upload image directly as binary if provided
    if (req.file) {
      // Upload the raw buffer directly without base64 conversion
      const uploadResult = await uploadAttendanceImage(
        req.file.buffer, // Direct binary buffer
        `attendance_${attendance_id}_${punch_type}.jpg`
      );
      imageUrl = uploadResult?.url ?? null;
    }

    // Update attendance record
    const updateQuery =
      punch_type === "IN"
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
      message: `Punch ${punch_type} updated successfully`,
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

// Mark attendance with only photo
router.post(
  "/face-attendance",
  upload.single("image"), // Single image upload
  async (req, res) => {
    try {
      const { punch_type } = req.body; // "IN" or "OUT"

      // 1. Face Detection
      const searchParams = {
        CollectionId: process.env.REKOGNITION_COLLECTION,
        Image: { Bytes: req.file.buffer },
        MaxFaces: 1,
        FaceMatchThreshold: 90,
      };

      const command = new SearchFacesByImageCommand(searchParams);
      const result = await rekognition.send(command);

      // 2. Verify Match
      if (!result.FaceMatches?.length) {
        return res.status(401).json({
          error: "No matching employee found",
          suggestion: "Use manual attendance if face recognition fails",
        });
      }

      const faceId = result.FaceMatches[0].Face.FaceId;

      // 3. Find Employee
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

      const emp_id = rows[0].emp_id;
      const today = new Date().toISOString().split("T")[0];

      // 4. Check/Create Attendance Record (similar to your existing logic)
      let attendance = await getOrCreateAttendanceRecord(emp_id, today);

      // 5. Process Punch (IN/OUT)
      if (punch_type === "IN" && attendance.punch_in_time) {
        return res.status(400).json({ error: "Already punched in today" });
      }
      if (punch_type === "OUT" && punch_out_time) {
        return res.status(400).json({ error: "Already punched out for today" });
      }
      if (punch_type === "OUT" && !punch_in_time) {
        return res
          .status(400)
          .json({ error: "Punch in first before Punching out" });
      }

      // 6. Update attendance (reuse your existing update logic)
      const updated = await processPunch(
        attendance.attendance_id,
        punch_type,
        req.file.buffer // For image storage
      );

      res.json({
        success: true,
        employee: rows[0].name,
        punch_type,
        time:
          punch_type === "IN" ? updated.punch_in_time : updated.punch_out_time,
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
