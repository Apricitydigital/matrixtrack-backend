const jwt = require("jsonwebtoken");
const pool = require('../config/db');

/**
 * Middleware specifically for professional employees (self punch-in).
 * Validates the JWT issued by the professional login endpoint.
 */
const authenticateProfessional = async (req, res, next) => {
  const bearer = req.header("Authorization") || req.header("authorization") || "";
  const headerToken = bearer.startsWith("Bearer ") ? bearer.split(" ")[1] : bearer || null;
  const token = req.cookies.token || headerToken;

  if (!token) {
    return res.status(401).json({ success: false, error: "Access denied, no token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Ensure this token is actually for a professional employee
    if (!decoded.professional_id) {
      return res.status(403).json({ success: false, error: "Invalid token type for professional routes" });
    }

    // Read current geography after profile edits even for an existing login token.
    const { rows } = await pool.query('SELECT city_id, zone_id, ward_id, kothi_id, is_active FROM professional_employees WHERE id = $1', [decoded.professional_id]);
    if (!rows[0]?.is_active) return res.status(403).json({ success: false, error: 'Professional account is inactive or unavailable' });
    req.professional = { ...decoded, ...rows[0] };
    next();
  } catch (error) {
    if (!['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(503).json({ success: false, error: 'Unable to load professional account. Please retry.' });
    }
    res.status(403).json({ success: false, error: "Invalid or expired professional token" });
  }
};

module.exports = authenticateProfessional;
