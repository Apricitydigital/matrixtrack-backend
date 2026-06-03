const jwt = require("jsonwebtoken");

/**
 * Middleware specifically for professional employees (self punch-in).
 * Validates the JWT issued by the professional login endpoint.
 */
const authenticateProfessional = (req, res, next) => {
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

    req.professional = decoded; 
    next();
  } catch (error) {
    res.status(403).json({ success: false, error: "Invalid or expired professional token" });
  }
};

module.exports = authenticateProfessional;
