/**
 * Middleware to enforce supervisor/admin access for routes.
 * Must be used AFTER the `authenticate` middleware which sets `req.user`.
 */
const requireSupervisor = (req, res, next) => {
  // Ensure req.user exists (set by authenticate middleware)
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized: User not authenticated." });
  }

  // Allow supervisor and admin for self-punch review routes.
  const normalizedRole = String(req.user.role || '').toLowerCase();
  if (normalizedRole !== 'supervisor' && normalizedRole !== 'admin') {
    return res.status(403).json({ success: false, message: "Forbidden: This action requires Supervisor or Admin access." });
  }

  // Set normalized user ID for easier access in controllers
  req.supervisorId = req.user.user_id || req.user.id || req.user.userId;

  if (!req.supervisorId) {
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid user context." });
  }

  next();
};

module.exports = {
  requireSupervisor
};
