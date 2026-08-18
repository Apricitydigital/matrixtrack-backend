const express = require("express");
const authenticate = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/permissionMiddleware");
const {
  getProfessionalGeofenceSettings,
  updateProfessionalGeofenceSettings,
  listProfessionalGeofenceRequests,
  reviewProfessionalGeofenceRequest,
  updateProfessionalGeofenceRadius,
  deleteProfessionalGeofenceRequest,
} = require("../controllers/professionalGeofenceController");

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

const requireProfessionalGeofenceToggleOwner = async (req, res, next) => {
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
      message: "Only MT Admin can manage professional geofencing toggle.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Unable to validate professional geofencing access.",
    });
  }
};

router.get(
  "/professional-geofencing/settings",
  authenticate,
  requireProfessionalGeofenceToggleOwner,
  getProfessionalGeofenceSettings
);

router.patch(
  "/professional-geofencing/settings",
  authenticate,
  requireProfessionalGeofenceToggleOwner,
  updateProfessionalGeofenceSettings
);

router.get(
  "/professional-geofencing/requests",
  authenticate,
  authorize("professional-geofencing", "view"),
  listProfessionalGeofenceRequests
);

router.patch(
  "/professional-geofencing/requests/:id",
  authenticate,
  authorize("professional-geofencing", "write"),
  reviewProfessionalGeofenceRequest
);

router.patch(
  "/professional-geofencing/requests/:id/radius",
  authenticate,
  authorize("professional-geofencing", "write"),
  updateProfessionalGeofenceRadius
);

router.delete(
  "/professional-geofencing/requests/:id",
  authenticate,
  authorize("professional-geofencing", "write"),
  deleteProfessionalGeofenceRequest
);

module.exports = router;
