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
} = require('../controllers/selfAttendanceReportsController');
const {
  getLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  getHolidayCalendar,
  createHoliday,
  deleteHoliday,
  getHolidayLogs,
} = require("../controllers/selfAttendanceLeaveManagementController");
const {
  getLeaveAllocations,
  setLeaveAllocations,
  getAllocationLogs,
} = require('../controllers/selfAttendanceLeaveAllocationsController');

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
 * @route   GET /api/admin/self-attendance-records
 */
router.get('/self-attendance-records', authorize('self-attendance-records', 'view'), getAttendanceList);

/**
 * @route   GET /api/admin/self-attendance-records/summary
 */
router.get('/self-attendance-records/summary', authorize('self-attendance-records', 'view'), getAttendanceSummary);
router.get('/self-attendance-records/date-range/summary', authorize('self-attendance-records', 'view'), getDateRangeAttendanceSummary);
router.get('/self-attendance-records/date-range/details', authorize('self-attendance-records', 'view'), getDateRangeAttendanceDetails);

/**
 * @route   GET /api/admin/self-attendance-employees
 */
router.get('/self-attendance-employees', getEmployeesList);

/**
 * @route   GET /api/admin/self-attendance-employees/:id/attendance
 */
router.get('/self-attendance-employees/:id/attendance', getEmployeeAttendance);

/**
 * @route   GET /api/admin/self-attendance-leave/requests
 */
router.get("/self-attendance-leave/requests", authorize("self-attendance-leave-mgmt", "view"), getLeaveRequests);

/**
 * @route   POST /api/admin/self-attendance-leave/requests/:id/approve
 */
router.post("/self-attendance-leave/requests/:id/approve", authorize("self-attendance-leave-mgmt", "write"), approveLeaveRequest);

/**
 * @route   POST /api/admin/self-attendance-leave/requests/:id/reject
 */
router.post("/self-attendance-leave/requests/:id/reject", authorize("self-attendance-leave-mgmt", "write"), rejectLeaveRequest);

/**
 * @route   GET /api/admin/self-attendance-leave/holidays
 */
router.get("/self-attendance-leave/holidays", authorize("self-attendance-holiday-declare", "view"), getHolidayCalendar);

/**
 * @route   POST /api/admin/self-attendance-leave/holidays
 */
router.post("/self-attendance-leave/holidays", authorize("self-attendance-holiday-declare", "write"), createHoliday);

/**
 * @route   DELETE /api/admin/self-attendance-leave/holidays/:id
 */
router.delete("/self-attendance-leave/holidays/:id", authorize("self-attendance-holiday-declare", "write"), deleteHoliday);

/**
 * @route   GET /api/admin/self-attendance-leave/holidays/logs
 */
router.get("/self-attendance-leave/holidays/logs", authorize("self-attendance-holiday-declare", "view"), getHolidayLogs);

/**
 * @route   GET /api/admin/self-attendance-leave/allocations/:id
 */
router.get('/self-attendance-leave/allocations/:id', authorize("self-attendance-leave-allocation", "view"), getLeaveAllocations);

/**
 * @route   PUT /api/admin/self-attendance-leave/allocations/:id
 */
router.put('/self-attendance-leave/allocations/:id', authorize("self-attendance-leave-allocation", "write"), setLeaveAllocations);

/**
 * @route   GET /api/admin/self-attendance-leave/allocations/:id/logs
 */
router.get('/self-attendance-leave/allocations/:id/logs', authorize("self-attendance-leave-allocation", "view"), getAllocationLogs);

module.exports = router;
