/**
 * External API Routes
 * Mounted at /api/v1/external — uses API key auth (no JWT).
 * Supports both READ and WRITE operations for attendance and employees.
 */

const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { apiKeyAuth, requireScope } = require("../middleware/apiKeyAuth");
const ctrl = require("../controllers/externalApiController");

// ── Global rate limiter for all external API routes ─────────────────────────
const externalRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please retry after 60 seconds.",
      retry_after: 60,
    },
  },
});

// Apply rate limiter and API key auth to all routes
router.use(externalRateLimiter);
router.use(apiKeyAuth);

// ── Health check ────────────────────────────────────────────────────────────
router.get("/health", (req, res) => {
  res.json({
    success: true,
    data: {
      status: "ok",
      key_name: req.apiKey.name,
      key_prefix: req.apiKey.prefix,
      scopes: req.apiKey.scopes,
    },
    meta: { api_version: "v1", timestamp: new Date().toISOString() },
  });
});

// ═══════════════════════════════════════════════════════════
//  SUPERVISOR / REGULAR EMPLOYEE ATTENDANCE
// ═══════════════════════════════════════════════════════════

// Read
router.get("/attendance/daily",            requireScope("attendance:read"),  ctrl.getDailyAttendance);
router.get("/attendance/range",             requireScope("attendance:read"),  ctrl.getAttendanceRange);
router.get("/attendance/summary",           requireScope("attendance:read"),  ctrl.getAttendanceSummary);
router.get("/attendance/employee/:empId",   requireScope("attendance:read"),  ctrl.getEmployeeAttendance);

// Write
router.post("/attendance/punch-in",         requireScope("attendance:write"), ctrl.markPunchIn);
router.post("/attendance/punch-out",        requireScope("attendance:write"), ctrl.markPunchOut);
router.post("/attendance/mark-leave",       requireScope("attendance:write"), ctrl.markLeave);
router.put("/attendance/:attendanceId",     requireScope("attendance:write"), ctrl.editAttendance);
router.delete("/attendance/:attendanceId",  requireScope("attendance:write"), ctrl.deleteAttendance);

// ═══════════════════════════════════════════════════════════
//  PROFESSIONAL ATTENDANCE
// ═══════════════════════════════════════════════════════════

// Read
router.get("/professional/attendance/daily", requireScope("attendance:read"), ctrl.getProfessionalDailyAttendance);

// Write
router.post("/professional/attendance/punch-in",   requireScope("attendance:write"), ctrl.markProfessionalPunchIn);
router.post("/professional/attendance/punch-out",  requireScope("attendance:write"), ctrl.markProfessionalPunchOut);
router.put("/professional/attendance/:id",         requireScope("attendance:write"), ctrl.editProfessionalAttendance);
router.delete("/professional/attendance/:id",      requireScope("attendance:write"), ctrl.deleteProfessionalAttendance);

// ═══════════════════════════════════════════════════════════
//  EMPLOYEE MANAGEMENT (CRUD)
// ═══════════════════════════════════════════════════════════

// Read
router.get("/employees",                    requireScope("employees:read"),   ctrl.getEmployees);
router.get("/employees/:empId",             requireScope("employees:read"),   ctrl.getEmployeeById);

// Write
router.post("/employees",                   requireScope("employees:write"),  ctrl.createEmployee);
router.put("/employees/:empId",             requireScope("employees:write"),  ctrl.updateEmployee);
router.delete("/employees/:empId",          requireScope("employees:write"),  ctrl.deleteEmployee);

module.exports = router;
