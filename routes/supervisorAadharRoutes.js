const express = require("express");
const router = express.Router();
const multer = require("multer");
const multerS3 = require("multer-s3");
const path = require("path");
const pool = require("../config/db");
const { s3 } = require("../config/awsConfig");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const authenticate = require("../middleware/authMiddleware");

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;

// multer-s3 config for supervisor aadhar docs
const uploadSupervisorAadhar = multer({
  storage: multerS3({
    s3,
    bucket: bucketName,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      // Saving in 'aadhar' folder (same as employee aadhaar)
      cb(null, `aadhar/${req.params.userId}_${Date.now()}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/jpg", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG, and PDF files are allowed"));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

/**
 * POST /api/supervisor-aadhar/:userId/upload
 */
router.post(
  "/:userId/upload",
  authenticate,
  (req, res, next) => {
    uploadSupervisorAadhar.single("aadhar_doc")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "File upload failed" });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (isNaN(userId)) return res.status(400).json({ error: "Invalid user ID" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const aadharDocUrl = req.file.location;
      const result = await pool.query(
        "UPDATE users SET aadhar_doc_url = $1 WHERE user_id = $2 RETURNING user_id, name, aadhar_doc_url",
        [aadharDocUrl, userId]
      );

      if (result.rowCount === 0) return res.status(404).json({ error: "Supervisor not found" });

      return res.json({
        message: "Aadhar document uploaded successfully",
        aadhar_doc_url: aadharDocUrl,
        user: result.rows[0],
      });
    } catch (error) {
      console.error("[SupervisorAadhar] Upload error:", error);
      return res.status(500).json({ error: "Failed to upload aadhar document" });
    }
  }
);

/**
 * GET /api/supervisor-aadhar/:userId/view
 * Streams the file from S3 directly
 */
router.get("/:userId/view", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) return res.status(400).json({ error: "Invalid user ID" });

    const result = await pool.query(
      "SELECT aadhar_doc_url FROM users WHERE user_id = $1",
      [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].aadhar_doc_url) {
      return res.status(404).json({ error: "Aadhar document not found" });
    }

    const docUrl = result.rows[0].aadhar_doc_url;

    if (docUrl.includes("amazonaws.com")) {
      let key = "";
      try {
        const urlObj = new URL(docUrl);
        key = decodeURIComponent(urlObj.pathname.replace(/^\/+/, ""));
      } catch {
        key = docUrl;
      }

      const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const response = await s3.send(command);

      const ext = key.split(".").pop().toLowerCase();
      let contentType = response.ContentType || "application/octet-stream";
      if (["jpg", "jpeg"].includes(ext)) contentType = "image/jpeg";
      else if (ext === "png") contentType = "image/png";
      else if (ext === "pdf") contentType = "application/pdf";

      const isDownload = req.query.download === 'true';
      const filename = key.split("/").pop();
      res.set({
        "Content-Type": contentType,
        "Content-Disposition": isDownload ? `attachment; filename="${filename}"` : "inline",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      });

      response.Body.pipe(res);
    } else {
      res.redirect(docUrl);
    }
  } catch (error) {
    console.error("[SupervisorAadhar] View error:", error);
    res.status(500).json({ error: "Failed to load aadhar document" });
  }
});

module.exports = router;
