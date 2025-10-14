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
const adminRoutes = require("./adminRoutes");

// Protected Route
router.get("/protected", authenticateUser, (req, res) => {
  res.json({ message: "You are authorized!", user: req.user });
});

// Register Routes
router.use("/employees", employeeRoutes);
router.use("/cities", cityRoutes);
router.use("/zones", zoneRoutes);
router.use("/wards", wardRoutes);
router.use("/departments", departmentRoutes);
router.use("/designations", designationRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/supervisor", supervisorRoutes);
router.use("/assignedWardRoutes", assignedWardRoutes);
router.use("/admin", adminRoutes);

module.exports = router;
