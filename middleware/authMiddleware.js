const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../config/db");

const authenticateToken = async (req, res, next) => {
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

  if (!token) {
    return res.status(401).json({ error: "Access denied, no token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Attach user data to request

    // Check if session has been force-revoked by Super Admin
    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const sessionCheck = await pool.query(
        "SELECT is_revoked FROM active_sessions WHERE token_hash = $1 LIMIT 1",
        [tokenHash]
      );
      if (sessionCheck.rows.length > 0 && sessionCheck.rows[0].is_revoked === true) {
        return res.status(403).json({
          error: "Your session has been terminated by the Super Admin. Please log in again.",
          code: "SESSION_REVOKED"
        });
      }
    } catch (dbErr) {
      // If DB check fails, don't block the request — just log warning
      console.error("Warning: Session revocation check failed:", dbErr.message);
    }

    next();
  } catch (error) {
    res.status(403).json({ error: "Invalid or expired token" });
  }
};

module.exports = authenticateToken;
