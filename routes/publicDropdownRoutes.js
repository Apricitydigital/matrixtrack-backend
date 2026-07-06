const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  getCities,
  getZones,
  getWards,
  getKothis
} = require('../controllers/publicDropdownController');

const router = express.Router();

// Rate limiting: 60 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all public dropdown routes
router.use(apiLimiter);

router.get('/cities', getCities);
router.get('/zones', getZones);
router.get('/wards', getWards);
router.get('/kothis', getKothis);

module.exports = router;
