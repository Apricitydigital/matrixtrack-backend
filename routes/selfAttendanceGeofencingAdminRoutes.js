const express = require("express");
const authenticate = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/permissionMiddleware");
const { attachCityScope } = require("../middleware/cityScope");
const {
  getSelfAttendanceGeofenceSettings,
  updateSelfAttendanceGeofenceSettings,
  listSelfAttendanceGeofenceRequests,
  reviewSelfAttendanceGeofenceRequest,
  updateSelfAttendanceGeofenceRadius,
  deleteSelfAttendanceGeofenceRequest,
} = require("../controllers/selfAttendanceGeofenceController");

const router = express.Router();
const SUPER_ADMIN_EMAIL =
  process.env.SUPER_ADMIN_EMAIL || "mtadmin@apricitydigital.in";
const SUPER_ADMIN_DB_EMAIL =
  process.env.SUPER_ADMIN_DB_EMAIL || "admin@gmail.com";

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const isAllowedSuperAdminEmail = (value) => {
  const email = normalizeEmail(value);
  return (
    email === normalizeEmail(SUPER_ADMIN_EMAIL) ||
    email === normalizeEmail(SUPER_ADMIN_DB_EMAIL)
  );
};

const requireSelfAttendanceGeofenceToggleOwner = async (req, res, next) => {
  try {
    const userId = req.user?.user_id || req.user?.id || req.user?.userId;
    const tokenEmail = req.user?.email;
    let email = tokenEmail;

    if (!email && userId) {
      const pool = require("../config/db");
      const userResult = await pool.query(
        "SELECT email FROM users WHERE user_id = $1 LIMIT 1",
        [userId]
      );
      email = userResult.rows[0]?.email || "";
    }

    if (isAllowedSuperAdminEmail(email)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: "Only MT Admin can manage self_attendance geofencing toggle.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to validate self_attendance geofencing access.",
    });
  }
};

router.get(
  "/self-attendance-geofencing/settings",
  authenticate,
  requireSelfAttendanceGeofenceToggleOwner,
  getSelfAttendanceGeofenceSettings
);

router.patch(
  "/self-attendance-geofencing/settings",
  authenticate,
  requireSelfAttendanceGeofenceToggleOwner,
  updateSelfAttendanceGeofenceSettings
);

router.get(
  "/self-attendance-geofencing/requests",
  authenticate,
  attachCityScope,
  authorize("self-attendance-geofencing", "view"),
  listSelfAttendanceGeofenceRequests
);

router.patch(
  "/self-attendance-geofencing/requests/:id",
  authenticate,
  attachCityScope,
  authorize("self-attendance-geofencing", "write"),
  reviewSelfAttendanceGeofenceRequest
);

router.patch(
  "/self-attendance-geofencing/requests/:id/radius",
  authenticate,
  attachCityScope,
  authorize("self-attendance-geofencing", "write"),
  updateSelfAttendanceGeofenceRadius
);

router.delete(
  "/self-attendance-geofencing/requests/:id",
  authenticate,
  attachCityScope,
  authorize("self-attendance-geofencing", "write"),
  deleteSelfAttendanceGeofenceRequest
);

module.exports = router;
