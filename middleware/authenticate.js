const jwt = require("jsonwebtoken");

const authenticate = (req, res, next) => {
  // Accept token from cookie, Authorization header, or fallback headers
  const bearer = req.header("Authorization") || req.header("authorization") || "";
  const headerToken = bearer.startsWith("Bearer ") ? bearer.split(" ")[1] : bearer || null;
  const fallbackHeader = req.header("x-access-token") || req.header("token");
  
  // Standard priority: Authorization Header > Cookie > Others
  const token = headerToken || req.cookies?.token || fallbackHeader;

  if (!token) {
    return res.status(401).json({ message: "Access Denied. No token provided." });
  }

  try {
    const secretKey = process.env.JWT_SECRET || "ankit";
    const decoded = jwt.verify(token, secretKey);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("[authenticate] Token verification failed:", err.message);
    // Standardizing the response so mobile and web can handle it gracefully
    if (err.name === "TokenExpiredError") {
      return res.status(403).json({ 
        message: "Token expired", 
        error: "Token expired", 
        code: "TOKEN_EXPIRED" 
      });
    }
    res.status(403).json({ message: "Invalid or expired token." });
  }
};

module.exports = authenticate;
