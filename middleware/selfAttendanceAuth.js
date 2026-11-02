const jwt = require("jsonwebtoken");
const pool = require('../config/db');
const {resolveEmployeeAlias}=require('../utils/employeeAliases');

/**
 * Middleware specifically for self_attendance employees (self punch-in).
 * Validates the JWT issued by the self_attendance login endpoint.
 */
const authenticateSelfAttendance = async (req, res, next) => {
  const bearer = req.header("Authorization") || req.header("authorization") || "";
  const headerToken = bearer.startsWith("Bearer ") ? bearer.split(" ")[1] : bearer || null;
  const token = req.cookies.token || headerToken;

  if (!token) {
    return res.status(401).json({ success: false, error: "Access denied, no token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Previously issued tokens remain valid until their normal expiry.
    if (decoded.self_attendance_id && decoded.professional_id && decoded.self_attendance_id !== decoded.professional_id) {
      return res.status(403).json({success:false,error:'Conflicting account identity.'});
    }
    decoded.self_attendance_id = decoded.self_attendance_id || decoded.professional_id;
    delete decoded.professional_id;

    // Ensure this token is actually for a self_attendance employee
    if (!decoded.self_attendance_id) {
      return res.status(403).json({ success: false, error: "Invalid token type for self_attendance routes" });
    }
    decoded.self_attendance_id=await resolveEmployeeAlias('self_attendance',decoded.self_attendance_id);

    // Read current geography after profile edits even for an existing login token.
    const { rows } = await pool.query('SELECT city_id, zone_id, ward_id, kothi_id, is_active FROM self_attendance_employees WHERE id = $1', [decoded.self_attendance_id]);
    if (!rows[0]?.is_active) return res.status(403).json({ success: false, error: 'SelfAttendance account is inactive or unavailable' });
    req.self_attendance = { ...decoded, ...rows[0] };
    next();
  } catch (error) {
    if (!['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(503).json({ success: false, error: 'Unable to load self_attendance account. Please retry.' });
    }
    res.status(403).json({ success: false, error: "Invalid or expired self_attendance token" });
  }
};

module.exports = authenticateSelfAttendance;
