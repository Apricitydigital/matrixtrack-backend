const express = require('express');
const { requireSupervisor } = require('../middleware/supervisorAccess');
const authenticate = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/permissionMiddleware');
const {
  getRequests,
  getRequestDetails,
  approveRequest,
  rejectRequest,
  getLogs
} = require('../controllers/supervisorSelfPunchController');

const router = express.Router();

// Apply authentication and supervisor role enforcement to all routes in this file
router.use(authenticate, requireSupervisor);

/**
 * @route   GET /api/supervisor/self-punch/requests
 * @desc    Get paginated list of self-punch requests
 * @access  Private (Supervisor only)
 */
router.get('/requests', authorize('field-access-requests', 'view'), getRequests);

/**
 * @route   GET /api/supervisor/self-punch/requests/logs
 * @desc    Get all logs for visible requests
 * @access  Private (Supervisor only)
 */
router.get('/requests/logs', authorize('field-access-requests', 'view'), getLogs);

/**
 * @route   GET /api/supervisor/self-punch/requests/:id
 * @desc    Get full detail of a single request including logs
 * @access  Private (Supervisor only)
 */
router.get('/requests/:id', authorize('field-access-requests', 'view'), getRequestDetails);

/**
 * @route   POST /api/supervisor/self-punch/requests/:id/approve
 * @desc    Approve a request
 * @access  Private (Supervisor only)
 */
router.post('/requests/:id/approve', authorize('field-access-requests', 'write'), approveRequest);

/**
 * @route   POST /api/supervisor/self-punch/requests/:id/reject
 * @desc    Reject a request
 * @access  Private (Supervisor only)
 */
router.post('/requests/:id/reject', authorize('field-access-requests', 'write'), rejectRequest);

module.exports = router;
