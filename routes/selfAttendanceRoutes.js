const express = require('express');
const authenticateSelfAttendance = require('../middleware/selfAttendanceAuth');
const { resolveAttendanceIdentity } = require('../utils/selfAttendanceRecordsIdentity');

const { login } = require('../controllers/selfAttendanceAuthController');
const { sendOtp, verifyOtp } = require('../controllers/selfAttendanceOtpController');
const { 
  punchIn, 
  punchOut, 
  getMonthlyAttendance, 
  getTodayStatus,
  getProfile 
} = require('../controllers/selfAttendanceRecordsController');
const {
  getMyNotifications,
  markNotificationRead,
} = require("../controllers/selfAttendanceLeaveController");
const { requestLeave, getMyLeaveRequests, getBalance: getMyLeaveBalance, getTeamRequests, review: reviewTeamLeave } = require('../controllers/selfAttendanceLeaveWorkflowController');
const { sendPushToSelfAttendances } = require('../utils/selfAttendancePushService');
const {
  registerPushToken,
  unregisterPushToken,
} = require("../controllers/selfAttendancePushController");
const {
  getMyGeofenceStatus,
  submitSelfAttendanceGeofenceRequest,
} = require("../controllers/selfAttendanceGeofenceController");

const router = express.Router();
const { getReminderSettings, saveReminderSettings } = require('../controllers/selfAttendanceReminderSettingsController');

// -----------------------------------------------------
// PUBLIC ROUTES
// -----------------------------------------------------
router.post('/auth/login', login);
router.post('/auth/send-otp', sendOtp);
router.post('/auth/verify-otp', verifyOtp);

// -----------------------------------------------------
// PROTECTED ROUTES (Requires Self Attendance JWT)
// -----------------------------------------------------
router.use(authenticateSelfAttendance);

// Profile
router.get('/profile', getProfile);

// Attendance
router.post('/attendance/punch-in', resolveAttendanceIdentity, punchIn);
router.post('/attendance/punch-out', resolveAttendanceIdentity, punchOut);
router.get('/attendance/monthly', resolveAttendanceIdentity, getMonthlyAttendance);
router.get('/attendance/status', resolveAttendanceIdentity, getTodayStatus);
router.get('/geofencing/status', getMyGeofenceStatus);
router.post('/geofencing/request', submitSelfAttendanceGeofenceRequest);

// Self Attendance leave and notifications
router.post("/leave/request", requestLeave);
router.get("/leave/requests", getMyLeaveRequests);
router.get("/leave/balance", getMyLeaveBalance);
router.get('/leave/team-requests', getTeamRequests);
router.post('/leave/team-requests/:id/review', reviewTeamLeave);
router.get("/notifications", getMyNotifications);
router.post("/notifications/:id/read", markNotificationRead);
router.post("/push-token/register", registerPushToken);
router.post("/push-token/unregister", unregisterPushToken);
router.get('/reminder-settings', getReminderSettings);
router.post('/reminder-settings', saveReminderSettings);

const { runSelfAttendancePunchInReminder } = require('../utils/selfAttendancePunchInReminder');

router.post('/notifications/trigger-reminders', async (req, res) => {
  try {
    if (process.env.SELF_ATTENDANCE_REMINDER_MANUAL_TRIGGER_ENABLED !== 'true') {
      return res.status(403).json({
        success: false,
        message: 'Bulk reminder trigger is disabled. Use the self test-push endpoint for testing.',
      });
    }
    const result = await runSelfAttendancePunchInReminder();
    res.json({ success: true, message: 'Punch-in reminders dispatched', result });
  } catch (error) {
    console.error('Failed to trigger reminders:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sends a real device push only to the currently authenticated self_attendance.
router.post('/notifications/test-push', async (req, res) => {
  try {
    const selfAttendanceId = req.self_attendance?.self_attendance_id;
    const result = await sendPushToSelfAttendances([{
      self_attendance_id: selfAttendanceId,
      type: 'push-test',
      title: 'MatrixTrack Test Notification',
      message: 'Push notifications are working on this device.',
      metadata: { category: 'test' },
    }]);

    if (!result.sent) {
      return res.status(409).json({
        success: false,
        message: 'No active push destination was available for this self_attendance.',
        result,
      });
    }

    res.json({ success: true, message: 'Test push sent.', result });
  } catch (error) {
    console.error('[SelfAttendancePush] Test push failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
