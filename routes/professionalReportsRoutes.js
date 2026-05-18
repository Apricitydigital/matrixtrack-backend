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
const {
  getLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  getHolidayCalendar,
  createHoliday,
  deleteHoliday,
  getHolidayLogs,
} = require("../controllers/professionalLeaveManagementController");
const {
  getLeaveAllocations,
  setLeaveAllocations,
  getAllocationLogs,
} = require('../controllers/professionalLeaveAllocationsController');

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

/**
 * @route   GET /api/admin/professional-leave/requests
 */
router.get("/professional-leave/requests", authorize("professional-leave-mgmt", "view"), getLeaveRequests);

/**
 * @route   POST /api/admin/professional-leave/requests/:id/approve
 */
router.post("/professional-leave/requests/:id/approve", authorize("professional-leave-mgmt", "write"), approveLeaveRequest);

/**
 * @route   POST /api/admin/professional-leave/requests/:id/reject
 */
router.post("/professional-leave/requests/:id/reject", authorize("professional-leave-mgmt", "write"), rejectLeaveRequest);

/**
 * @route   GET /api/admin/professional-leave/holidays
 */
router.get("/professional-leave/holidays", authorize("professional-holiday-declare", "view"), getHolidayCalendar);

/**
 * @route   POST /api/admin/professional-leave/holidays
 */
router.post("/professional-leave/holidays", authorize("professional-holiday-declare", "write"), createHoliday);

/**
 * @route   DELETE /api/admin/professional-leave/holidays/:id
 */
router.delete("/professional-leave/holidays/:id", authorize("professional-holiday-declare", "write"), deleteHoliday);

/**
 * @route   GET /api/admin/professional-leave/holidays/logs
 */
router.get("/professional-leave/holidays/logs", authorize("professional-holiday-declare", "view"), getHolidayLogs);

/**
 * @route   GET /api/admin/professional-leave/allocations/:id
 */
router.get('/professional-leave/allocations/:id', authorize("professional-leave-allocation", "view"), getLeaveAllocations);

/**
 * @route   PUT /api/admin/professional-leave/allocations/:id
 */
router.put('/professional-leave/allocations/:id', authorize("professional-leave-allocation", "write"), setLeaveAllocations);

/**
 * @route   GET /api/admin/professional-leave/allocations/:id/logs
 */
router.get('/professional-leave/allocations/:id/logs', authorize("professional-leave-allocation", "view"), getAllocationLogs);

module.exports = router;
