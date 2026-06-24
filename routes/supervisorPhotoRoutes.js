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

// multer-s3 config for supervisor profile photos
const uploadSupervisorPhoto = multer({
  storage: multerS3({
    s3,
    bucket: bucketName,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      // Saving in 'supervisor_image' folder
      cb(null, `supervisor_image/${req.params.userId}_${Date.now()}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG and WEBP files are allowed for photos"));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

/**
 * POST /api/supervisor-photo/:userId/upload
 */
router.post(
  "/:userId/upload",
  authenticate,
  (req, res, next) => {
    uploadSupervisorPhoto.single("photo")(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || "Photo upload failed" });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (isNaN(userId)) {
        console.error("[SupervisorPhoto] Invalid user ID:", req.params.userId);
        return res.status(400).json({ error: "Invalid user ID" });
      }
      
      if (!req.file) {
        console.error("[SupervisorPhoto] No photo received for user:", userId);
        return res.status(400).json({ error: "No photo uploaded" });
      }

      const photoUrl = req.file.location;
      console.log(`[SupervisorPhoto] Uploading photo for user ${userId} to S3: ${photoUrl}`);

      const result = await pool.query(
        "UPDATE users SET profile_photo_url = $1 WHERE user_id = $2 RETURNING user_id, name, profile_photo_url",
        [photoUrl, userId]
      );

      if (result.rowCount === 0) {
        console.error("[SupervisorPhoto] User not found in database:", userId);
        return res.status(404).json({ error: "Supervisor not found" });
      }

      console.log(`[SupervisorPhoto] Database updated successfully for user ${userId}`);

      return res.json({
        message: "Profile photo uploaded successfully",
        profile_photo_url: photoUrl,
        user: result.rows[0],
      });
    } catch (error) {
      console.error("[SupervisorPhoto] Internal upload error:", error);
      return res.status(500).json({ error: "Failed to save profile photo link in database" });
    }
  }
);

/**
 * GET /api/supervisor-photo/:userId/view
 * Streams the photo from S3 directly
 */
router.get("/:userId/view", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) return res.status(400).json({ error: "Invalid user ID" });

    const result = await pool.query(
      "SELECT profile_photo_url FROM users WHERE user_id = $1",
      [userId]
    );

    if (result.rows.length === 0 || !result.rows[0].profile_photo_url) {
      return res.status(404).json({ error: "Profile photo not found" });
    }

    const photoUrl = result.rows[0].profile_photo_url;

    if (photoUrl.includes("amazonaws.com")) {
      let key = "";
      try {
        const urlObj = new URL(photoUrl);
        key = decodeURIComponent(urlObj.pathname.replace(/^\/+/, ""));
      } catch {
        key = photoUrl;
      }

      const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
      const response = await s3.send(command);

      const ext = key.split(".").pop().toLowerCase();
      let contentType = response.ContentType || "image/jpeg";
      if (["jpg", "jpeg"].includes(ext)) contentType = "image/jpeg";
      else if (ext === "png") contentType = "image/png";

      res.set({
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      });

      response.Body.pipe(res);
    } else {
      res.redirect(photoUrl);
    }
  } catch (error) {
    console.error("[SupervisorPhoto] View error:", error);
    res.status(500).json({ error: "Failed to load profile photo" });
  }
});

module.exports = router;
