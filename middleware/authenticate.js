const jwt = require("jsonwebtoken");

const authenticate = (req, res, next) => {
  // Get token from headers
  const token = req.header("Authorization");

  // Check if token exists
  if (!token) {
    return res
      .status(401)
      .json({ message: "Access Denied. No token provided." });
  }

  try {
    // Verify token
    const secretKey = process.env.JWT_SECRET || "ankit"; // Use env variable in production
    const decoded = jwt.verify(token.replace("Bearer ", ""), secretKey);

    // Attach user info to request object
    req.user = decoded;
    next(); // Proceed to next middleware or route handler
  } catch (err) {
    res.status(403).json({ message: "Invalid or expired token." });
  }
};

module.exports = authenticate;
