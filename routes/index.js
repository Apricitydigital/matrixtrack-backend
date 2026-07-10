const express = require("express");
const router = express.Router();

// Middleware
const authenticateUser = require("../middleware/authMiddleware");

// Import all route files
const employeeRoutes = require("./employeeRoutes");
const cityRoutes = require("./cityRoutes");
const zoneRoutes = require("./zoneRoutes");
const wardRoutes = require("./wardRoutes");
const departmentRoutes = require("./departmentRoutes");
const designationRoutes = require("./designationRoutes");
const attendanceRoutes = require("./attendanceRoutes");
const supervisorRoutes = require("./supervisorRoutes");
const assignedWardRoutes = require("./assignedWardRoutes");
const assignedKothiRoutes = require("./assignedKothiRoutes");
const adminRoutes = require("./adminRoutes");
const rbacRoutes = require("./rbacRoutes");
const whatsappRoutes = require("./whatsappRoutes");
const userRoutes = require("./userRoutes");
const sectorRoutes = require("./sectorRoutes");
const geofencingRoutes = require("./geofencingRoutes");
const supervisorAuditRoutes = require("./supervisorAuditRoutes");
const supervisorAadharRoutes = require("./supervisorAadharRoutes");
const supervisorPhotoRoutes = require("./supervisorPhotoRoutes");
const otpRoutes = require("./otpRoutes");
const appRoutes = require("./appRoutes/index");
const publicDropdownRoutes = require("./publicDropdownRoutes");
const publicSelfPunchRoutes = require("./publicSelfPunchRoutes");
const supervisorSelfPunchRoutes = require("./supervisorSelfPunchRoutes");
const professionalRoutes = require("./professionalRoutes");
const professionalReportsRoutes = require("./professionalReportsRoutes");
const cityCostRoutes = require("./cityCostRoutes");

// Protected Route
router.get("/protected", authenticateUser, (req, res) => {
  res.json({ message: "You are authorized!", user: req.user });
});

// Generic logging endpoints
router.post("/log-page-visit", authenticateUser, (req, res) => {
  res.json({ success: true, message: "Page visit logged" });
});

router.post("/log-action", authenticateUser, (req, res) => {
  res.json({ success: true, message: "Custom action logged" });
});

// Register Routes
router.use("/employees", employeeRoutes);
router.use("/cities", cityRoutes);
router.use("/zones", zoneRoutes);
router.use("/wards", wardRoutes);
router.use("/sectors", sectorRoutes);
router.use("/geofencing", geofencingRoutes);
router.use("/departments", departmentRoutes);
router.use("/designations", designationRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/supervisor", supervisorRoutes);
router.use("/supervisor/self-punch", supervisorSelfPunchRoutes);
router.use("/professional", professionalRoutes);

// Mount reports before the main adminRoutes to bypass strict requireAdmin middleware
// allowing both admins and supervisors to access these specific reporting endpoints.
router.use("/admin", professionalReportsRoutes);

router.use("/assignedWardRoutes", assignedWardRoutes);
router.use("/assignedKothiRoutes", assignedKothiRoutes);
router.use("/admin", adminRoutes);
router.use("/admin-management", require("./adminManagementRoutes"));
router.use("/admin-management/city-cost", cityCostRoutes);
router.use("/rbac", rbacRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/user", userRoutes);
router.use("/supervisor-audit", supervisorAuditRoutes);
router.use("/supervisor-aadhar", supervisorAadharRoutes);
router.use("/supervisor-photo", supervisorPhotoRoutes);
router.use("/otp", otpRoutes);
// Compatibility mount so /api/app/* works even if appRoutes isn't mounted in app.js.
router.use("/app", appRoutes);

// Public API endpoints
router.use("/public", publicDropdownRoutes);
router.use("/public/self-punch", publicSelfPunchRoutes);

module.exports = router;
