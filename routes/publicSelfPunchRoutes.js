const express = require('express');
const rateLimit = require('express-rate-limit');
const { upload, handleMulterError, submitRequest } = require('../controllers/selfPunchController');

const router = express.Router();

// Rate limiting: 5 requests per hour per IP
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { success: false, message: 'Too many requests from this IP, please try again after an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @route   POST /api/public/self-punch/request
 * @desc    Submit a new self-punch registration request
 * @access  Public
 */
router.post(
  '/request',
  submitLimiter,
  upload,
  handleMulterError,
  submitRequest
);

module.exports = router;
