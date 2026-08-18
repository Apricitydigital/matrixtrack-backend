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
  process.env.SUPER_ADMIN_EMAIL || "admin@gmail.com";

const requireProfessionalGeofenceToggleOwner = (req, res, next) => {
  const email = String(req.user?.email || "").trim().toLowerCase();
  if (email !== String(SUPER_ADMIN_EMAIL).trim().toLowerCase()) {
    return res.status(403).json({
      success: false,
      message: "Only MT Admin can manage professional geofencing toggle.",
    });
  }
  next();
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
