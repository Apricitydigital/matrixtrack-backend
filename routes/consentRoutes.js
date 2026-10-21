'use strict';
/**
 * consentRoutes.js
 * Express routes for DPDP Biometric & Aadhaar Consent logging
 */

const express = require('express');
const router = express.Router();
const { recordConsentApi, getConsentStatusApi } = require('../controllers/consentController');
const authenticateToken = require('../middleware/authMiddleware');
const authenticateProfessional = require('../middleware/professionalAuth');

router.get('/professional/status', authenticateProfessional, getConsentStatusApi);
router.get('/supervisor/status', authenticateToken, getConsentStatusApi);

/**
 * POST /api/consent/log
 * Public / Authenticated route to record consent
 */
router.post('/log', recordConsentApi);

module.exports = router;
