const express = require("express");
const router = express.Router();

// Import all route files
const supervisorsWards = require("./supervisorsWard");
const attendanceRoutes = require("./newAttendaceRoutes");
const employeeRoutes = require("./employeeDetail");
const faceRoutes = require("./faceRoutes");

// App Routes
router.use("/supervisor/wards", supervisorsWards);
router.use("/attendance/employee", attendanceRoutes);
router.use("/attendance/employee/detail", employeeRoutes);
router.use("/attendance/employee/faceRoutes", faceRoutes);

module.exports = router;
