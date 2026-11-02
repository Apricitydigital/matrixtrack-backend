const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const {hasLoginAliases}=require('../utils/employeeAliases');
const {findSelfAttendanceLogin}=require('../utils/selfAttendanceMergeLogin');
let selfAttendancePasswordColumnCache = null;
const SELF_ATTENDANCE_JWT_EXPIRES_IN = process.env.SELF_ATTENDANCE_JWT_EXPIRES_IN || '45d';

const getSelfAttendancePasswordColumn = async () => {
  if (selfAttendancePasswordColumnCache) {
    return selfAttendancePasswordColumnCache;
  }

  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'self_attendance_employees'`
  );

  const columns = new Set(rows.map((r) => String(r.column_name)));
  if (columns.has('password_hash')) {
    selfAttendancePasswordColumnCache = 'password_hash';
  } else if (columns.has('password')) {
    selfAttendancePasswordColumnCache = 'password';
  } else {
    // Do not cache null; column may be added dynamically during first approval.
    return null;
  }

  return selfAttendancePasswordColumnCache;
};

/**
 * @desc    Login self_attendance employee and return JWT
 * @route   POST /api/self-attendance/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  try {
    const passwordColumn = await getSelfAttendancePasswordColumn();
    if (!passwordColumn) {
      return res.status(500).json({
        success: false,
        message: 'Self Attendance login is not configured: password column missing.'
      });
    }

    // ORDER BY is_active DESC, created_at DESC ensures we always pick the
    // active/newest account when the same email has multiple records
    // (e.g. one rejected request + one approved request).
    const identifier = email.trim().toLowerCase();
    const rawIdentifier = email.trim();
    const {self_attendance,retiredHashes}=await findSelfAttendanceLogin(pool,identifier,rawIdentifier,passwordColumn,await hasLoginAliases());
    if (!self_attendance) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    if (!self_attendance.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Please contact your supervisor.' });
    }

    // Verify Password
    let isMatch=false;
    for(const hash of new Set([self_attendance.password_hash,...retiredHashes].filter(Boolean))) {
      if(await bcrypt.compare(password,hash)){isMatch=true;break;}
    }
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    // Generate JWT for app self_attendance session
    const payload = {
      self_attendance_id: self_attendance.id,
      ward_id: self_attendance.ward_id,
      zone_id: self_attendance.zone_id,
      city_id: self_attendance.city_id,
      face_locked: self_attendance.face_locked
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: SELF_ATTENDANCE_JWT_EXPIRES_IN });

    logger.info(`[SelfAttendanceAuth] Login successful for self_attendance_id: ${self_attendance.id}`);

    res.json({
      success: true,
      token,
      self_attendance: {
        id: self_attendance.id,
        email: self_attendance.email,
        face_locked: self_attendance.face_locked
      }
    });

  } catch (error) {
    logger.error('[SelfAttendanceAuth] Login error', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  login
};
