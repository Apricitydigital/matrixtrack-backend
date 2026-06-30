const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const authenticateToken = (req, res, next) => {
  // Accept token from cookie, Authorization header, fallback headers, or query param
  const bearer =
    req.header("Authorization") || req.header("authorization") || "";
  const headerToken = bearer.startsWith("Bearer ")
    ? bearer.split(" ")[1]
    : bearer || null;
  const fallbackHeader = req.header("x-access-token") || req.header("token");
  const queryToken = req.query?.token;
  const token =
    req.cookies.token || headerToken || fallbackHeader || queryToken;

  const logFile = path.join(__dirname, "../auth_debug.log");

  if (!token) {
    fs.appendFileSync(logFile, `[Auth Error] ${req.method} ${req.originalUrl} - No token provided\n`);
    return res.status(401).json({ error: "Access denied, no token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Attach user data to request
    fs.appendFileSync(logFile, `[Auth Success] ${req.method} ${req.originalUrl} - User: ${JSON.stringify(decoded)}\n`);
    next();
  } catch (error) {
    fs.appendFileSync(logFile, `[Auth Failure] ${req.method} ${req.originalUrl} - Verify failed: ${error.message}\n`);
    res.status(403).json({ error: "Invalid or expired token" });
  }
};

module.exports = authenticateToken;
