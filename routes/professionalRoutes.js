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
router.get('/reminder-settings', async (req, res) => {
  try {
    const { professional_id } = req.professional;
    const result = await pool.query(
      `SELECT COALESCE(reminder_enabled, true) AS reminder_enabled, COALESCE(reminder_time, '10:00') AS reminder_time FROM professional_employees WHERE id = $1`,
      [professional_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Professional employee not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reminder-settings', async (req, res) => {
  try {
    const { professional_id } = req.professional;
    const { reminder_enabled, reminder_time } = req.body;
    
    await pool.query(
      `UPDATE professional_employees 
       SET reminder_enabled = COALESCE($1, reminder_enabled),
           reminder_time = COALESCE($2, reminder_time)
       WHERE id = $3`,
      [typeof reminder_enabled === 'boolean' ? reminder_enabled : null, reminder_time || null, professional_id]
    );

    res.json({ success: true, message: 'Notification reminder settings updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const { runProfessionalPunchInReminder } = require('../utils/professionalPunchInReminder');

router.post('/notifications/trigger-reminders', async (req, res) => {
  try {
    const { target_time } = req.body || {};
    const result = await runProfessionalPunchInReminder(target_time || null);
    res.json({ success: true, message: 'Punch-in reminders dispatched', result });
  } catch (error) {
    console.error('Failed to trigger reminders:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
