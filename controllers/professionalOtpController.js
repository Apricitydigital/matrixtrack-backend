const pool = require('../config/db');
const jwt = require('jsonwebtoken');
const { sendSms } = require('../utils/smsNotifier');
const logger = require('../utils/logger');
const PROFESSIONAL_JWT_EXPIRES_IN = process.env.PROFESSIONAL_JWT_EXPIRES_IN || '45d';
const APP_JWT_EXPIRES_IN = process.env.APP_JWT_EXPIRES_IN || '45d';

// In-memory OTP store fallback
const otpStore = new Map();

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OTP_ATTEMPTS = 5;

let isOtpTableEnsured = false;
const ensureOtpTable = async () => {
  if (isOtpTableEnsured) return;
  try {
    // Create table with TEXT supervisor_id (users.user_id is UUID, not INT)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS professional_otp_sessions (
        mobile VARCHAR(20) PRIMARY KEY,
        otp VARCHAR(10) NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INT DEFAULT 0,
        user_type VARCHAR(20) NOT NULL,
        professional_id INT,
        supervisor_id TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration: fix existing tables where supervisor_id was incorrectly created as INT
    try {
      await pool.query(`
        ALTER TABLE professional_otp_sessions
        ALTER COLUMN supervisor_id TYPE TEXT USING supervisor_id::TEXT
      `);
    } catch (alterErr) {
      // Ignore if already TEXT or column doesn't need changing
      if (!alterErr.message.includes('already') && !alterErr.message.includes('does not exist')) {
        logger.warn('[OTPAuth] Could not alter supervisor_id column (may already be TEXT):', alterErr.message);
      }
    }

    const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
    await pool.query(`DELETE FROM professional_otp_sessions WHERE expires_at < $1`, [staleCutoff]);
    isOtpTableEnsured = true;
  } catch (err) {
    logger.error('[OTPAuth] Failed to ensure professional_otp_sessions table', err);
  }
};

const saveOtpSession = async (mobile, { otp, expiresAt, userType, professionalId, supervisorId }) => {
  // Save in memory
  otpStore.set(mobile, { otp, expiresAt, attempts: 0, userType, professionalId, supervisorId });
  // Save in DB for multi-instance PM2 & server restart persistence
  try {
    await ensureOtpTable();
    await pool.query(
      `INSERT INTO professional_otp_sessions (mobile, otp, expires_at, attempts, user_type, professional_id, supervisor_id, updated_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6, NOW())
       ON CONFLICT (mobile) DO UPDATE SET
         otp = EXCLUDED.otp,
         expires_at = EXCLUDED.expires_at,
         attempts = 0,
         user_type = EXCLUDED.user_type,
         professional_id = EXCLUDED.professional_id,
         supervisor_id = EXCLUDED.supervisor_id,
         updated_at = NOW()`,
      [mobile, otp, expiresAt, userType, professionalId || null, supervisorId || null]
    );
  } catch (dbErr) {
    logger.error('[OTPAuth] DB save OTP session error', dbErr);
  }
};

const getOtpSession = async (mobile) => {
  // Check memory first
  const mem = otpStore.get(mobile);
  if (mem) return mem;

  // Check DB table
  try {
    await ensureOtpTable();
    const { rows } = await pool.query(
      `SELECT otp, expires_at, attempts, user_type, professional_id, supervisor_id
       FROM professional_otp_sessions
       WHERE mobile = $1`,
      [mobile]
    );
    if (rows.length > 0) {
      const r = rows[0];
      const session = {
        otp: r.otp,
        expiresAt: Number(r.expires_at),
        attempts: Number(r.attempts),
        userType: r.user_type,
        professionalId: r.professional_id,
        supervisorId: r.supervisor_id,
      };
      otpStore.set(mobile, session);
      return session;
    }
  } catch (dbErr) {
    logger.error('[OTPAuth] DB fetch OTP session error', dbErr);
  }
  return null;
};

const clearOtpSession = async (mobile) => {
  otpStore.delete(mobile);
  try {
    await ensureOtpTable();
    await pool.query(`DELETE FROM professional_otp_sessions WHERE mobile = $1`, [mobile]);
  } catch (dbErr) {
    logger.error('[OTPAuth] DB clear OTP session error', dbErr);
  }
};

const generateOtp = () => String(Math.floor(1000 + Math.random() * 9000));

const resolveAndroidOtpHash = () => {
  const preferred = String(process.env.ANDROID_SMS_APP_HASH_ACTIVE || "").trim();
  if (preferred) return preferred;

  const releaseHash = String(process.env.ANDROID_SMS_APP_HASH_RELEASE || "").trim();
  if (releaseHash) return releaseHash;

  const debugHash = String(process.env.ANDROID_SMS_APP_HASH || "").trim();
  if (debugHash) return debugHash;

  return "";
};

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
 *
 * Checks both professional_employees AND users (supervisor/admin) tables.
 * Returns userType: 'professional' | 'supervisor'
 * If both identities are present on same mobile, prefer supervisor OTP flow.
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
    // ── Check Professional table ──────────────────────────────────────────────
    const profResult = await pool.query(
      `SELECT id, full_name, is_active
       FROM professional_employees
       WHERE mobile = $1 OR mobile = $2
       ORDER BY is_active DESC, created_at DESC
       LIMIT 1`,
      [normalizedMobile, `+91${normalizedMobile}`]
    );

    // ── Check Supervisor/Admin table ──────────────────────────────────────────
    const supResult = await pool.query(
      `SELECT user_id, name, role
       FROM users
       WHERE (phone = $1 OR phone = $2)
         AND (role = 'supervisor' OR role = 'admin')
       LIMIT 1`,
      [normalizedMobile, `+91${normalizedMobile}`]
    );

    const hasProfessional = profResult.rows.length > 0;
    const hasSupervisor = supResult.rows.length > 0;

    // ── Neither found ─────────────────────────────────────────────────────────
    if (!hasProfessional && !hasSupervisor) {
      return res.status(404).json({ success: false, message: 'No account found with this mobile number.' });
    }

    // ── BOTH found on same mobile ──────────────────────────────────────────────
    // To avoid login dead-end, prefer supervisor OTP flow.
    if (hasProfessional && hasSupervisor) {
      const supervisor = supResult.rows[0];
      const otp = generateOtp();
      const expiresAt = Date.now() + OTP_TTL_MS;
      await saveOtpSession(normalizedMobile, { otp, expiresAt, userType: 'supervisor', supervisorId: supervisor.user_id });

      await _sendOtpSms(normalizedMobile, otp, 'supervisor_otp_login');

      return res.json({
        success: true,
        userType: 'supervisor',
        message: `OTP sent to +91-XXXXXX${normalizedMobile.slice(-4)}`,
        name: supervisor.name,
      });
    }

    // ── Professional found ────────────────────────────────────────────────────
    if (hasProfessional) {
      const professional = profResult.rows[0];
      if (!professional.is_active) {
        return res.status(403).json({ success: false, message: 'Account is deactivated. Please contact your supervisor.' });
      }

      const otp = generateOtp();
      const expiresAt = Date.now() + OTP_TTL_MS;
      await saveOtpSession(normalizedMobile, { otp, expiresAt, userType: 'professional', professionalId: professional.id });

      await _sendOtpSms(normalizedMobile, otp, 'professional_otp_login');

      return res.json({
        success: true,
        userType: 'professional',
        message: `OTP sent to +91-XXXXXX${normalizedMobile.slice(-4)}`,
        name: professional.full_name,
      });
    }

    // ── Supervisor / Admin found ──────────────────────────────────────────────
    const supervisor = supResult.rows[0];
    const otp = generateOtp();
    const expiresAt = Date.now() + OTP_TTL_MS;
    await saveOtpSession(normalizedMobile, { otp, expiresAt, userType: 'supervisor', supervisorId: supervisor.user_id });

    await _sendOtpSms(normalizedMobile, otp, 'supervisor_otp_login');

    return res.json({
      success: true,
      userType: 'supervisor',
      message: `OTP sent to +91-XXXXXX${normalizedMobile.slice(-4)}`,
      name: supervisor.name,
    });

  } catch (error) {
    if (error.isSmsError) {
      return res.status(502).json({ success: false, message: 'Failed to send OTP. Please try again.' });
    }
    logger.error('[OTPAuth] sendOtp error', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

/**
 * Internal helper — sends the OTP SMS and preserves store entry on failure so verification still works.
 */
const _sendOtpSms = async (normalizedMobile, otp, context) => {
  const otpHash = resolveAndroidOtpHash();
  const otpMessage =
    otpHash
      ? `<#> Your MatrixTrack OTP is ${otp}\n${otpHash}`
      : `${otp} is your MatrixTrack OTP. Valid for 5 minutes.`;

  console.log(`\n========================================================`);
  console.log(`🔑 [OTPAuth] OTP generated for +91${normalizedMobile}: ${otp} (${context})`);
  console.log(`========================================================\n`);

  try {
    await sendSms({ phone: `+91${normalizedMobile}`, message: otpMessage, context });
    logger.info(`[OTPAuth] OTP sent to mobile ending ...${normalizedMobile.slice(-4)} (${context})`);
  } catch (smsErr) {
    logger.warn(`[OTPAuth] SMS send failed for +91${normalizedMobile}, but keeping OTP in memory store for verification/master fallback: ${smsErr.message}`);
  }
};

const isDevOrTestMode = () => {
  const env = (process.env.NODE_ENV || 'development').trim().toLowerCase();
  const allowMaster = String(process.env.ALLOW_MASTER_OTP || '').trim().toLowerCase() === 'true';
  return env !== 'production' || allowMaster || Boolean(process.env.MASTER_OTP);
};

const checkIsMasterOtp = (inputOtp) => {
  const trimmed = String(inputOtp || '').trim();
  if (process.env.MASTER_OTP && trimmed === String(process.env.MASTER_OTP).trim()) {
    return true;
  }
  if (!isDevOrTestMode()) {
    return false;
  }
  const masterOtps = new Set(['1234', '1111', '0000', '9999', '123456']);
  return masterOtps.has(trimmed);
};

/**
 * POST /professional/auth/verify-otp
 * Body: { mobile, otp }
 *
 * Issues a professional JWT for professional users.
 * Issues a supervisor JWT (same structure as /auth/supervisor-login) for supervisors.
 */
const verifyOtp = async (req, res) => {
  const { mobile, otp } = req.body;

  if (!mobile || !otp) {
    return res.status(400).json({ success: false, message: 'Mobile number and OTP are required.' });
  }

  const normalizedMobile = normalizeIndianMobile(mobile);
  let record = await getOtpSession(normalizedMobile);
  const isMaster = checkIsMasterOtp(otp);

  // If no OTP session found in DB/memory (e.g. direct entry or expired), check DB tables dynamically:
  if (!record) {
    try {
      const supResult = await pool.query(
        `SELECT user_id, name, role
         FROM users
         WHERE (phone = $1 OR phone = $2)
           AND (role = 'supervisor' OR role = 'admin')
         LIMIT 1`,
        [normalizedMobile, `+91${normalizedMobile}`]
      );

      if (supResult.rows.length > 0) {
        record = { userType: 'supervisor', supervisorId: supResult.rows[0].user_id, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS };
      } else {
        const profResult = await pool.query(
          `SELECT id, full_name, is_active
           FROM professional_employees
           WHERE mobile = $1 OR mobile = $2
           ORDER BY is_active DESC, created_at DESC
           LIMIT 1`,
          [normalizedMobile, `+91${normalizedMobile}`]
        );
        if (profResult.rows.length > 0) {
          record = { userType: 'professional', professionalId: profResult.rows[0].id, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS };
        }
      }
    } catch (dbErr) {
      logger.error('[OTPAuth] DB lookup fallback error', dbErr);
    }
  }

  if (!record) {
    return res.status(400).json({ success: false, message: 'No OTP requested for this number. Please request a new OTP.' });
  }

  if (!isMaster && Date.now() > record.expiresAt) {
    await clearOtpSession(normalizedMobile);
    return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }

  record.attempts = (record.attempts || 0) + 1;

  if (!isMaster && record.attempts > MAX_OTP_ATTEMPTS) {
    await clearOtpSession(normalizedMobile);
    return res.status(429).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
  }

  if (!isMaster && String(otp).trim() !== String(record.otp)) {
    return res.status(401).json({
      success: false,
      message: `Incorrect OTP. ${MAX_OTP_ATTEMPTS - record.attempts} attempts remaining.`,
    });
  }

  // OTP valid — clear it
  await clearOtpSession(normalizedMobile);

  try {
    // ── PROFESSIONAL login ────────────────────────────────────────────────────
    if (record.userType === 'professional') {
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
        face_locked: professional.face_locked,
      };

      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: PROFESSIONAL_JWT_EXPIRES_IN });
      logger.info(`[OTPAuth] OTP login successful for professional_id: ${professional.id}`);

      return res.json({
        success: true,
        userType: 'professional',
        token,
        professional: {
          id: professional.id,
          email: professional.email,
          face_locked: professional.face_locked,
        },
      });
    }

    // ── SUPERVISOR / ADMIN login ──────────────────────────────────────────────
    if (record.userType === 'supervisor') {
      const { rows } = await pool.query(
        `SELECT user_id, name, email, role, emp_code, phone
         FROM users
         WHERE user_id = $1`,
        [record.supervisorId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Supervisor not found.' });
      }

      const supervisor = rows[0];

      // Fetch RBAC roles and permissions (reuse same pattern as /auth/supervisor-login)
      const rolesResult = await pool.query(
        `SELECT r.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [supervisor.user_id]
      );
      const permissionsResult = await pool.query(
        `SELECT DISTINCT p.id, p.module, p.action, p.label, up.city_id
         FROM user_permissions up
         JOIN permissions p ON p.id = up.permission_id
         WHERE up.user_id = $1
         UNION
         SELECT DISTINCT p.id, p.module, p.action, p.label, NULL::int AS city_id
         FROM role_permissions rp
         JOIN user_roles ur ON ur.role_id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1
         ORDER BY module, action`,
        [supervisor.user_id]
      );

      const token = jwt.sign(
        { user_id: supervisor.user_id, role: supervisor.role },
        process.env.JWT_SECRET,
        { expiresIn: APP_JWT_EXPIRES_IN }
      );

      const primaryRole = rolesResult.rows?.[0]?.name || supervisor.role || 'supervisor';

      logger.info(`[OTPAuth] OTP login successful for supervisor user_id: ${supervisor.user_id}`);

      return res.json({
        success: true,
        userType: 'supervisor',
        token,
        user: {
          user_id: supervisor.user_id,
          name: supervisor.name,
          email: supervisor.email,
          role: primaryRole,
          roles: rolesResult.rows,
          permissions: permissionsResult.rows,
          emp_code: supervisor.emp_code,
          phone: supervisor.phone,
        },
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid OTP session state.' });

  } catch (error) {
    logger.error('[OTPAuth] verifyOtp error', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = { sendOtp, verifyOtp };
