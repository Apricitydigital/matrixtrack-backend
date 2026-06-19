const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const multer = require("multer");
const multerS3 = require("multer-s3");
const path = require("path");
const fs = require("fs");
const { s3 } = require("../config/awsConfig");

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;

const uploadAadhar = multer({
  storage: multerS3({
    s3,
    bucket: bucketName,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `aadhar/${req.params.id}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});
const { buildPublicFaceUrl } = require("../utils/faceImage");
const { isBackblazeUrl } = require("../utils/backblaze");
const authenticate = require("../middleware/authMiddleware");
const { attachCityScope, requireCityScope, buildCityFilterClause } = require("../middleware/cityScope");
const { attachKothiScope, buildKothiFilterClause } = require("../middleware/kothiScope");

const resolveFaceImageUrl = (faceEmbedding, empId) => {
  if (!faceEmbedding) {
    return null;
  }

  const publicUrl = buildPublicFaceUrl(faceEmbedding);
  if (publicUrl) {
    return publicUrl;
  }

  if (isBackblazeUrl(faceEmbedding) && empId !== undefined && empId !== null) {
    return `app/attendance/employee/faceRoutes/image/${empId}`;
  }

  if (typeof faceEmbedding === "string") {
    return faceEmbedding;
  }

  return null;
};

const formatEmployeeRow = (row = {}) => {
  const faceImageUrl = resolveFaceImageUrl(row.face_embedding, row.emp_id);
  const faceRegistered = Boolean(row.face_embedding);

  return {
    ...row,
    face_registered: faceRegistered,
    faceRegistered,
    face_image_url: faceImageUrl,
    faceImageUrl,
    aadhar_no: row.aadhar_no,
    aadhar_url: row.aadhar_url
  };
};

const parseId = (id) => {
  if (id === undefined || id === null) return null;
  if (typeof id === "string" && id.trim() === "") return null;
  const parsed = parseInt(id, 10);
  return isNaN(parsed) ? null : parsed;
};

// 🟢 Fetch all employees with city, zone, ward, department, and designation
router.get(
  "/",
  authenticate,
  attachKothiScope,
  attachCityScope,
  requireCityScope(),
  async (req, res) => {
    try {
      const scope = req.cityScope || { all: false, ids: [] };
      const kothiScope = req.kothiScope || { all: true, ids: [] };
      
      const cityFilter = buildCityFilterClause(scope, "c", []);
      const kothiFilter = buildKothiFilterClause(kothiScope, "w", cityFilter.params);

      const result = await pool.query(
        `SELECT 
        e.emp_id, 
        e.name, 
        e.emp_code, 
        e.phone, 
        c.city_name AS city, 
        z.zone_name AS zone, 
        w.ward_name AS ward, 
        d.department_name AS department, 
        ds.designation_name AS designation,
        e.face_embedding,
        e.aadhar_no,
        e.aadhar_url
      FROM employee e
      LEFT JOIN wards w ON e.ward_id = w.ward_id
      LEFT JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN designation ds ON e.designation_id = ds.designation_id
      LEFT JOIN department d ON ds.department_id = d.department_id
      ${cityFilter.clause} ${kothiFilter.clause};`,
        kothiFilter.params
      );
    res.json(result.rows.map(formatEmployeeRow));
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Insert or update an employee (idempotent)
router.post("/", async (req, res) => {
  const { name, emp_code, phone, ward_id, designation_id } = req.body;

  if (!emp_code) {
    return res.status(400).json({ error: "emp_code is required" });
  }

  const upsertEmployeeQuery = `
    INSERT INTO employee (emp_code, name, phone, ward_id, designation_id, aadhar_no)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (emp_code)
    DO UPDATE SET
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      ward_id = EXCLUDED.ward_id,
      designation_id = EXCLUDED.designation_id,
      aadhar_no = EXCLUDED.aadhar_no
    RETURNING *;
  `;

  try {
    const result = await pool.query(upsertEmployeeQuery, [
      emp_code,
      name,
      phone,
      parseId(ward_id),
      parseId(designation_id),
      req.body.aadhar_no || null
    ]);
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "Employee already exists",
        emp_code,
      });
    }
    console.error("Error inserting employee:", error);
    return res.status(500).json({ message: "Internal error" });
  }
});

// 🟢 Update an existing employee and return updated details
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, emp_code, phone, ward_id, designation_id } = req.body;
    const result = await pool.query(
      `UPDATE employee 
       SET name = $1, emp_code = $2, phone = $3, ward_id = $4, designation_id = $5, aadhar_no = $6 
       WHERE emp_id = $7 
       RETURNING *`,
      [name, emp_code, phone, parseId(ward_id), parseId(designation_id), req.body.aadhar_no || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // Fetch the updated details
    const updatedEmployee = await pool.query(
      `SELECT 
          e.emp_id, 
          e.name, 
          e.emp_code, 
          e.phone, 
          c.city_name AS city, 
          z.zone_name AS zone, 
          w.ward_name AS ward, 
          d.department_name AS department, 
          ds.designation_name AS designation,
          e.face_embedding,
          e.aadhar_no,
          e.aadhar_url
       FROM employee e
       LEFT JOIN wards w ON e.ward_id = w.ward_id
       LEFT JOIN zones z ON w.zone_id = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       LEFT JOIN designation ds ON e.designation_id = ds.designation_id
       LEFT JOIN department d ON ds.department_id = d.department_id
       WHERE e.emp_id = $1;`,
      [id]
    );

    res.json(formatEmployeeRow(updatedEmployee.rows[0]));
  } catch (error) {
    console.error("Error updating employee:", error);
    if (error.code === "23505") {
      return res.status(409).json({
        error: `Employee with emp_code ${req.body.emp_code} already exists`,
      });
    }
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Delete an employee
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM employee WHERE emp_id = $1", [
      id,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }

    res.json({ message: "Employee deleted successfully" });
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Upload Aadhar Document
router.post("/:id/aadhar", uploadAadhar.single("document"), async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
        return res.status(400).json({ error: "Invalid Employee ID" });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`[Aadhar] Uploading for ID: ${id}, File: ${req.file.location}`);

    // Use URL returned by S3
    const aadharUrl = req.file.location;

    const result = await pool.query(
      "UPDATE employee SET aadhar_url = $1 WHERE emp_id = $2 RETURNING *",
      [aadharUrl, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Employee not found in database" });
    }

    res.json({ message: "Aadhar uploaded successfully", aadhar_url: aadharUrl });
  } catch (error) {
    console.error("Error uploading Aadhar:", error);
    res.status(500).json({ error: "Failed to upload Aadhar document" });
  }
});

// 🟢 Proxy/View Aadhar Document
router.get("/:id/aadhar/view", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT aadhar_url FROM employee WHERE emp_id = $1", [id]);
    
    if (result.rows.length === 0 || !result.rows[0].aadhar_url) {
      return res.status(404).json({ error: "Aadhar document not found" });
    }
    
    const aadharUrl = result.rows[0].aadhar_url;

    // Case 1: Local URL (from before S3 connection)
    if (aadharUrl.includes("/uploads/aadhar/")) {
      return res.redirect(aadharUrl);
    }

    // Case 2: S3 URL
    if (aadharUrl.includes("amazonaws.com") || !aadharUrl.startsWith("http")) {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
      
      let key = "";
      try {
        const urlObj = new URL(aadharUrl);
        key = decodeURIComponent(urlObj.pathname.replace(/^\/+/, ""));
      } catch (e) {
        key = aadharUrl;
      }

      const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const response = await s3.send(command);

      // Detect content type from extension if S3 doesn't provide it reliably
      const ext = key.split('.').pop().toLowerCase();
      let contentType = response.ContentType || 'application/octet-stream';
      if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg';
      else if (ext === 'png') contentType = 'image/png';
      else if (ext === 'pdf') contentType = 'application/pdf';

      const filename = key.split('/').pop();
      const isDownload = req.query.download === '1';

      res.set({
        "Content-Type": contentType,
        "Content-Disposition": isDownload ? `attachment; filename="${filename}"` : "inline",
        "Cache-Control": "no-store",
      });

      response.Body.pipe(res);
    } else {
      res.redirect(aadharUrl);
    }
  } catch (error) {
    console.error("Error viewing Aadhar:", error);
    res.status(500).json({ error: "Unable to load Aadhar document" });
  }
});

module.exports = router;
