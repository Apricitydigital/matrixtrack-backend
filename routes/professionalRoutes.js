const express = require('express');
const authenticateProfessional = require('../middleware/professionalAuth');

const { login } = require('../controllers/professionalAuthController');
const { 
  punchIn, 
  punchOut, 
  getMonthlyAttendance, 
  getProfile 
} = require('../controllers/professionalAttendanceController');

const router = express.Router();

// -----------------------------------------------------
// PUBLIC ROUTES
// -----------------------------------------------------
router.post('/auth/login', login);

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

module.exports = router;
