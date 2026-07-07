const express = require('express');
const authenticateProfessional = require('../middleware/professionalAuth');

const { login } = require('../controllers/professionalAuthController');
const { sendOtp, verifyOtp } = require('../controllers/professionalOtpController');
const { 
  punchIn, 
  punchOut, 
  getMonthlyAttendance, 
  getTodayStatus,
  getProfile 
} = require('../controllers/professionalAttendanceController');
const {
  requestLeave,
  getMyLeaveRequests,
  getMyNotifications,
  markNotificationRead,
} = require("../controllers/professionalLeaveController");
const { getMyLeaveBalance } = require('../controllers/professionalLeaveAllocationsController');
const {
  registerPushToken,
  unregisterPushToken,
} = require("../controllers/professionalPushController");

const router = express.Router();

// -----------------------------------------------------
// PUBLIC ROUTES
// -----------------------------------------------------
router.post('/auth/login', login);
router.post('/auth/send-otp', sendOtp);
router.post('/auth/verify-otp', verifyOtp);

// -----------------------------------------------------
// PROTECTED ROUTES (Requires Professional JWT)
// -----------------------------------------------------
router.use(authenticateProfessional);

// Profile
router.get('/profile', getProfile);

// Attendance
router.post('/attendance/punch-in', punchIn);
router.post('/attendance/punch-out', punchOut);
router.get('/attendance/monthly', getMonthlyAttendance);
router.get('/attendance/status', getTodayStatus);

// Professional leave and notifications
router.post("/leave/request", requestLeave);
router.get("/leave/requests", getMyLeaveRequests);
router.get("/leave/balance", getMyLeaveBalance);
router.get("/notifications", getMyNotifications);
router.post("/notifications/:id/read", markNotificationRead);
router.post("/push-token/register", registerPushToken);
router.post("/push-token/unregister", unregisterPushToken);

module.exports = router;
