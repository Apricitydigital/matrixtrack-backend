const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const { sendSms } = require('../utils/smsNotifier');
const logger = require('../utils/logger');
const PROFESSIONAL_JWT_EXPIRES_IN = process.env.PROFESSIONAL_JWT_EXPIRES_IN || '45d';

// In-memory OTP store: { mobile → { otp, expiresAt, attempts } }
// For production, use Redis or DB table for persistence across restarts.
const otpStore = new Map();

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OTP_ATTEMPTS = 5;

const generateOtp = () => String(Math.floor(1000 + Math.random() * 9000));

const normalizeIndianMobile = (raw = '') => {
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  return digits.slice(-10);
};

/**
 * POST /professional/auth/send-otp
 * Body: { mobile }
 */
const sendOtp = async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) {
    return res.status(400).json({ success: false, message: 'Mobile number is required.' });
  }

  const normalizedMobile = normalizeIndianMobile(mobile);
  if (normalizedMobile.length !== 10) {
    return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
  }

  try {
    // Check professional exists and is active.
    // ORDER BY is_active DESC ensures the active account is picked first
    // when a user has multiple records (e.g. one rejected + one approved).
    const { rows } = await pool.query(
      `SELECT id, full_name, is_active 
       FROM professional_employees 
       WHERE mobile = $1 OR mobile = $2
       ORDER BY is_active DESC, created_at DESC
       LIMIT 1`,
      [normalizedMobile, `+91${normalizedMobile}`]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No account found with this mobile number.' });
    }

    const professional = rows[0];

    if (!professional.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Please contact your supervisor.' });
    }

    const otp = generateOtp();
    const expiresAt = Date.now() + OTP_TTL_MS;

    otpStore.set(normalizedMobile, { otp, expiresAt, attempts: 0, professionalId: professional.id });

    // Send SMS
    try {
      await sendSms({
        phone: `+91${normalizedMobile}`,
        message: `Your MatrixTrack login OTP is ${otp}. Valid for 5 minutes. Do not share with anyone.`,
        context: 'professional_otp_login'
      });
      logger.info(`[OTPAuth] OTP sent to mobile ending ...${normalizedMobile.slice(-4)}`);
    } catch (smsErr) {
      logger.error('[OTPAuth] SMS send failed', smsErr);
      // Remove OTP if SMS fails so user can retry
      otpStore.delete(normalizedMobile);
      return res.status(502).json({ success: false, message: 'Failed to send OTP. Please try again.' });
    }

    res.json({
      success: true,
      message: `OTP sent to +91-XXXXXX${normalizedMobile.slice(-4)}`,
      name: professional.full_name
    });

  } catch (error) {
    logger.error('[OTPAuth] sendOtp error', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

/**
 * POST /professional/auth/verify-otp
 * Body: { mobile, otp }
 */
const verifyOtp = async (req, res) => {
  const { mobile, otp } = req.body;

  if (!mobile || !otp) {
    return res.status(400).json({ success: false, message: 'Mobile number and OTP are required.' });
  }

  const normalizedMobile = normalizeIndianMobile(mobile);
  const record = otpStore.get(normalizedMobile);

  if (!record) {
    return res.status(400).json({ success: false, message: 'No OTP requested for this number. Please request a new OTP.' });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedMobile);
    return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }

  record.attempts += 1;

  if (record.attempts > MAX_OTP_ATTEMPTS) {
    otpStore.delete(normalizedMobile);
    return res.status(429).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
  }

  if (String(otp).trim() !== String(record.otp)) {
    return res.status(401).json({ success: false, message: `Incorrect OTP. ${MAX_OTP_ATTEMPTS - record.attempts} attempts remaining.` });
  }

  // OTP valid — clear it
  otpStore.delete(normalizedMobile);

  try {
    const { rows } = await pool.query(
      `SELECT pe.id, pe.email, pe.face_locked, pe.ward_id, pe.zone_id, pe.city_id,
              c.city_name, z.zone_name, w.ward_name
       FROM professional_employees pe
       LEFT JOIN cities c ON c.city_id = pe.city_id
       LEFT JOIN zones z ON z.zone_id = pe.zone_id
       LEFT JOIN wards w ON w.ward_id = pe.ward_id
       WHERE pe.id = $1`,
      [record.professionalId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Professional not found.' });
    }

    const professional = rows[0];

    const payload = {
      professional_id: professional.id,
      ward_id: professional.ward_id,
      zone_id: professional.zone_id,
      city_id: professional.city_id,
      face_locked: professional.face_locked
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: PROFESSIONAL_JWT_EXPIRES_IN });

    logger.info(`[OTPAuth] OTP login successful for professional_id: ${professional.id}`);

    res.json({
      success: true,
      token,
      professional: {
        id: professional.id,
        email: professional.email,
        face_locked: professional.face_locked
      }
    });

  } catch (error) {
    logger.error('[OTPAuth] verifyOtp error', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = { sendOtp, verifyOtp };
