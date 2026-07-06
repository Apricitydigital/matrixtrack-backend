const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { upload, handleMulterError, submitRequest } = require('../controllers/selfPunchController');

const router = express.Router();

const normalizeMobile = (value) => String(value || '').replace(/\D/g, '').slice(-10);

// Rate limiting: scoped by IP + mobile to avoid blocking different users on same Wi-Fi.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 40,
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(req.ip || req.ipAddress || '');
    const mobile = normalizeMobile(req.body?.mobile);
    if (mobile.length === 10) {
      return `${ipKey}:${mobile}`;
    }
    return ipKey;
  },
  message: {
    success: false,
    message: 'Hourly limit reached: max 40 requests per mobile number per hour.'
  },
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
