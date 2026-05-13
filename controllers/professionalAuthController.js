const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
let professionalPasswordColumnCache = null;
const PROFESSIONAL_JWT_EXPIRES_IN = process.env.PROFESSIONAL_JWT_EXPIRES_IN || '45d';

const getProfessionalPasswordColumn = async () => {
  if (professionalPasswordColumnCache) {
    return professionalPasswordColumnCache;
  }

  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'professional_employees'`
  );

  const columns = new Set(rows.map((r) => String(r.column_name)));
  if (columns.has('password_hash')) {
    professionalPasswordColumnCache = 'password_hash';
  } else if (columns.has('password')) {
    professionalPasswordColumnCache = 'password';
  } else {
    // Do not cache null; column may be added dynamically during first approval.
    return null;
  }

  return professionalPasswordColumnCache;
};

/**
 * @desc    Login professional employee and return JWT
 * @route   POST /api/professional/auth/login
 * @access  Public
 */
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  try {
    const passwordColumn = await getProfessionalPasswordColumn();
    if (!passwordColumn) {
      return res.status(500).json({
        success: false,
        message: 'Professional login is not configured: password column missing.'
      });
    }

    // ORDER BY is_active DESC, created_at DESC ensures we always pick the
    // active/newest account when the same email has multiple records
    // (e.g. one rejected request + one approved request).
    const query = `
      SELECT id, email, ${passwordColumn} AS password_hash, is_active, face_locked, ward_id, zone_id, city_id 
      FROM professional_employees 
      WHERE email = $1
      ORDER BY is_active DESC, created_at DESC
      LIMIT 1
    `;
    const { rows } = await pool.query(query, [email.trim().toLowerCase()]);

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const professional = rows[0];

    if (!professional.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Please contact your supervisor.' });
    }

    // Verify Password
    const isMatch = await bcrypt.compare(password, professional.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    // Generate JWT for app professional session
    const payload = {
      professional_id: professional.id,
      ward_id: professional.ward_id,
      zone_id: professional.zone_id,
      city_id: professional.city_id,
      face_locked: professional.face_locked
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: PROFESSIONAL_JWT_EXPIRES_IN });

    logger.info(`[ProfessionalAuth] Login successful for professional_id: ${professional.id}`);

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
    logger.error('[ProfessionalAuth] Login error', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  login
};
