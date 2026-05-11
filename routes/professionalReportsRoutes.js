const express = require('express');
const authenticateUser = require('../middleware/authMiddleware');
const { attachCityScope } = require('../middleware/cityScope');
const { authorize } = require('../middleware/permissionMiddleware');
const {
  getAttendanceList,
  getAttendanceSummary,
  getDateRangeAttendanceSummary,
  getDateRangeAttendanceDetails,
  getEmployeesList,
  getEmployeeAttendance
} = require('../controllers/professionalReportsController');

const router = express.Router();

/**
 * Middleware to enforce Admin OR Supervisor role.
 */
const requireAdminOrSupervisor = (req, res, next) => {
  const role = req.user?.role?.toLowerCase();
  if (role !== 'admin' && role !== 'supervisor') {
    return res.status(403).json({ success: false, message: 'Access denied. Requires Admin or Supervisor role.' });
  }
  next();
};

// Apply auth, city scope resolution, and role enforcement
router.use(authenticateUser);
router.use(attachCityScope);
router.use(requireAdminOrSupervisor);

// Note: Mounted at /api/admin in index.js, so paths are relative to that.

/**
 * @route   GET /api/admin/professional-attendance
 */
router.get('/professional-attendance', authorize('professional-attendance', 'view'), getAttendanceList);

/**
 * @route   GET /api/admin/professional-attendance/summary
 */
router.get('/professional-attendance/summary', authorize('professional-attendance', 'view'), getAttendanceSummary);
router.get('/professional-attendance/date-range/summary', authorize('professional-attendance', 'view'), getDateRangeAttendanceSummary);
router.get('/professional-attendance/date-range/details', authorize('professional-attendance', 'view'), getDateRangeAttendanceDetails);

/**
 * @route   GET /api/admin/professional-employees
 */
router.get('/professional-employees', getEmployeesList);

/**
 * @route   GET /api/admin/professional-employees/:id/attendance
 */
router.get('/professional-employees/:id/attendance', getEmployeeAttendance);

module.exports = router;
