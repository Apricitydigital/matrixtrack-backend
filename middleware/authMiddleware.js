const jwt = require("jsonwebtoken");

/**
 * Sliding-window JWT middleware.
 *
 * - Accepts token from cookie, Authorization header, x-access-token or query param.
 * - If the token is valid but will expire within TOKEN_REFRESH_THRESHOLD seconds,
 *   a fresh token is issued and sent back via the `X-New-Token` response header
 *   AND the `token` cookie is updated.  The frontend can pick this up and store
 *   the new token so the session stays alive silently.
 */

const TOKEN_REFRESH_THRESHOLD = 2 * 60 * 60; // 2 hours in seconds

const authenticateToken = (req, res, next) => {
  // Accept token from cookie, Authorization header, fallback headers, or query param
  const bearer =
    req.header("Authorization") || req.header("authorization") || "";
  const headerToken = bearer.startsWith("Bearer ")
    ? bearer.split(" ")[1]
    : bearer || null;
  const fallbackHeader = req.header("x-access-token") || req.header("token");
  const queryToken = req.query?.token;
  // Standard priority: Authorization Header > Cookie > Others
  const token =
    headerToken || req.cookies?.token || fallbackHeader || queryToken;

  if (!token)
    return res.status(401).json({ error: "Access denied, no token provided" });

  try {
    const secretKey = process.env.JWT_SECRET || "ankit";
    const decoded = jwt.verify(token, secretKey);
    req.user = decoded;

    // ── Sliding window: proactively refresh if expiring soon ───────────────
    const now = Math.floor(Date.now() / 1000);
    const timeLeft = (decoded.exp || 0) - now;

    if (timeLeft > 0 && timeLeft < TOKEN_REFRESH_THRESHOLD) {
      const { iat, exp, ...payload } = decoded; // strip old timing claims
      const newToken = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "30d",
      });

      // Send new token in header (frontend reads it) and refresh cookie
      res.setHeader("X-New-Token", newToken);
      res.cookie("token", newToken, { httpOnly: true });
    }

    next();
  } catch (err) {
    // Standardizing the response so mobile and web can handle it gracefully
    if (err.name === "TokenExpiredError") {
      return res.status(403).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    res.status(403).json({ error: "Invalid token", code: "TOKEN_INVALID" });
  }
};

module.exports = authenticateToken;
