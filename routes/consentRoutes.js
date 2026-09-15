'use strict';
/**
 * consentRoutes.js
 * Express routes for DPDP Biometric & Aadhaar Consent logging
 */

const express = require('express');
const router = express.Router();
const { recordConsentApi } = require('../controllers/consentController');

/**
 * POST /api/consent/log
 * Public / Authenticated route to record consent
 */
router.post('/log', recordConsentApi);

module.exports = router;
