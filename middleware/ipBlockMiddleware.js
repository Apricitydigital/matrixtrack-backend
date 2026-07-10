const pool = require("../config/db");

module.exports = async (req, res, next) => {
  try {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || "";
    
    // If it is comma separated, get the first one
    if (clientIp.includes(",")) {
      clientIp = clientIp.split(",")[0].trim();
    }
    
    // Normalize IPv6 representation of IPv4 loopback (e.g. ::ffff:127.0.0.1)
    if (clientIp.startsWith("::ffff:")) {
      clientIp = clientIp.substring(7);
    }
    
    if (!clientIp) {
      return next();
    }
    
    // Query database to check if this IP is blocked
    const { rows } = await pool.query(
      "SELECT ip_address, reason FROM blocked_ips WHERE ip_address = $1",
      [clientIp]
    );
    
    if (rows.length > 0) {
      return res.status(403).json({
        error: "Access denied. Your IP address has been blocked.",
        reason: rows[0].reason || "No reason specified"
      });
    }
    
    next();
  } catch (error) {
    console.error("[IP Block Middleware] Error checking IP:", error);
    // Soft failure: do not crash the app if DB is temporarily unavailable
    next();
  }
};
