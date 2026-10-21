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

// Identity comes from the verified login token, never from a supplied account ID.
const getConsentStatusApi = async (req, res) => {
    try {
        const isProfessional = Boolean(req.professional);
        const id = isProfessional ? req.professional.professional_id : req.user.user_id;
        if (!id) return res.status(400).json({ success: false, message: 'Account identity is required.' });
        const { rows } = await pool.query(`
            SELECT consent_given FROM user_consent_logs
            WHERE ${isProfessional ? 'user_id = $1' : 'supervisor_id = $1'}
              AND actor_type = $2 AND consent_type = $3 AND consent_version = $4
            ORDER BY created_at DESC, id DESC LIMIT 1
        `, [id, isProfessional ? 'SELF' : 'SUPERVISOR_PROXY', 'BIOMETRIC_FACE_AND_AADHAR', 'v1.0']);
        return res.json({ success: true, consentGiven: rows[0]?.consent_given === true });
    } catch (error) {
        logger.error('[Consent] Failed to check consent:', error);
        return res.status(500).json({ success: false, message: 'Failed to check consent.' });
    }
};

module.exports = {
    getConsentStatusApi,
    logUserConsent,
    recordConsentApi
};
