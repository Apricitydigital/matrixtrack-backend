'use strict';
/**
 * consentController.js
 * Handles logging user and supervisor biometric & Aadhaar consent records (DPDP Act 2023)
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Log consent record in user_consent_logs table
 */
const logUserConsent = async ({
    userId = null,
    mobile = null,
    empCode = null,
    consentType = 'BIOMETRIC_FACE_AND_AADHAR',
    actorType = 'SELF',
    supervisorId = 0,
    consentGiven = true,
    consentVersion = 'v1.0',
    languageUsed = 'en',
    ipAddress = '',
    deviceInfo = ''
}, client = null) => {
    const dbClient = client || pool;
    const query = `
        INSERT INTO user_consent_logs (
            user_id, mobile, emp_code, consent_type, actor_type,
            supervisor_id, consent_given, consent_version, language_used,
            ip_address, device_info, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        RETURNING id;
    `;
    const values = [
        userId ? parseInt(userId, 10) : null,
        mobile ? String(mobile).trim() : null,
        empCode ? String(empCode).trim() : null,
        consentType,
        actorType,
        supervisorId ? parseInt(supervisorId, 10) : 0,
        Boolean(consentGiven),
        consentVersion,
        languageUsed || 'en',
        ipAddress || '',
        deviceInfo || ''
    ];
    const { rows } = await dbClient.query(query, values);
    logger.info(`[Consent] Logged ${actorType} consent ID ${rows[0]?.id} for mobile: ${mobile || empCode || userId}`);
    return rows[0]?.id;
};

/**
 * HTTP POST API endpoint to submit explicit consent from frontend/mobile apps
 * POST /api/consent/log
 */
const recordConsentApi = async (req, res) => {
    try {
        const {
            userId,
            mobile,
            empCode,
            consentType = 'BIOMETRIC_FACE_AND_AADHAR',
            actorType = 'SELF',
            supervisorId = 0,
            consentGiven = true,
            language = 'en',
            deviceInfo = ''
        } = req.body;

        if (!consentGiven) {
            return res.status(400).json({ success: false, message: 'Explicit consent is required.' });
        }

        const logId = await logUserConsent({
            userId,
            mobile,
            empCode,
            consentType,
            actorType,
            supervisorId,
            consentGiven,
            languageUsed: language,
            ipAddress: req.ip,
            deviceInfo
        });

        return res.status(201).json({
            success: true,
            consent_id: logId,
            message: 'Consent recorded successfully.'
        });
    } catch (error) {
        logger.error('[Consent] Failed to record consent:', error);
        return res.status(500).json({ success: false, message: 'Failed to record consent.' });
    }
};

module.exports = {
    logUserConsent,
    recordConsentApi
};
