/**
 * Face Re-Capture Request Routes  (App / Supervisor side)
 *
 * POST /app/face-request/create        — Submit a re-capture request
 * GET  /app/face-request/status        — Check own request status
 *
 * Business rules enforced here:
 *  - A user can only have ONE active (non-UPDATED) request at a time.
 *  - Only users whose face is already enrolled can request a re-capture.
 *  - Creating a request automatically inserts an admin notification.
 */

const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const authenticateUser = require("../../middleware/authMiddleware");

// All routes require a valid JWT token
router.use(authenticateUser);

// ──────────────────────────────────────────────────────────────────────────────
// POST /app/face-request/create
// Body: { emp_id? }  — emp_id is optional; defaults to the calling user's emp_id
// ──────────────────────────────────────────────────────────────────────────────
router.post("/create", async (req, res) => {
  try {
    const userId = req.user?.user_id ?? req.user?.id ?? null;

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthenticated" });
    }

    // Resolve emp_id: caller may pass it explicitly (for supervisor acting on behalf
    // of an employee), or we use the supervisor's own record.
    const rawEmpId = req.body?.emp_id ?? null;
    let empId = rawEmpId ? Number(rawEmpId) : null;

    // If no emp_id supplied, resolve it from the users table (supervisors have emp_code)
    if (!empId) {
      const { rows } = await pool.query(
        `SELECT emp_id FROM employee WHERE emp_code = (
           SELECT emp_code FROM users WHERE user_id = $1
         ) LIMIT 1`,
        [userId]
      );
      empId = rows[0]?.emp_id ?? null;
    }

    if (!empId) {
      return res.status(400).json({
        success: false,
        error: "Could not resolve employee record. Provide emp_id in the request body.",
      });
    }

    // Verify the employee actually has a face enrolled
    const { rows: empRows } = await pool.query(
      `SELECT face_embedding FROM employee WHERE emp_id = $1`,
      [empId]
    );

    if (!empRows.length || !empRows[0].face_embedding) {
      return res.status(400).json({
        success: false,
        error: "No face enrolled for this employee. Use the initial enrollment flow instead.",
      });
    }

    // Guard: only one active request allowed at a time
    const { rows: existing } = await pool.query(
      `SELECT id, status FROM face_recapture_requests
        WHERE user_id = $1 AND emp_id = $2 AND status NOT IN ('REJECTED', 'UPDATED')
        ORDER BY created_at DESC LIMIT 1`,
      [userId, empId]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        status: existing[0].status,
        requestId: existing[0].id,
        error: `A face re-capture request is already ${existing[0].status.toLowerCase()} for this user.`,
      });
    }

    // Create the request
    const { rows: inserted } = await pool.query(
      `INSERT INTO face_recapture_requests (user_id, emp_id, status)
         VALUES ($1, $2, 'REQUESTED')
         RETURNING id, status, requested_at`,
      [userId, empId]
    );

    const newRequest = inserted[0];

    // Fetch user info for the admin notification message
    const { rows: userRows } = await pool.query(
      `SELECT name, emp_code FROM users WHERE user_id = $1`,
      [userId]
    );
    const userName = userRows[0]?.name ?? `User #${userId}`;
    const empCode = userRows[0]?.emp_code ?? "";

    // Insert admin notification
    await pool.query(
      `INSERT INTO admin_notifications (type, title, message, reference_id)
         VALUES ('FACE_REQUEST_RECEIVED',
                 'Face Re-Capture Request',
                 $1,
                 $2)`,
      [
        `${userName}${empCode ? ` (${empCode})` : ""} has requested face re-capture (emp_id: ${empId}).`,
        newRequest.id,
      ]
    );

    return res.status(201).json({
      success: true,
      requestId: newRequest.id,
      status: newRequest.status,
      requestedAt: newRequest.requested_at,
      message: "Face re-capture request submitted. Awaiting admin approval.",
    });
  } catch (error) {
    console.error("[FaceRequest] create error:", error);
    return res.status(500).json({ success: false, error: "Server error", details: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /app/face-request/status
// Returns the most recent face-request record for the calling user.
// ──────────────────────────────────────────────────────────────────────────────
router.get("/status", async (req, res) => {
  try {
    const userId = req.user?.user_id ?? req.user?.id ?? null;

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthenticated" });
    }

    const empIdParam = req.query.emp_id ? Number(req.query.emp_id) : null;

    let query = `
      SELECT id, emp_id, status, requested_at, reviewed_at, rejection_reason, notes
        FROM face_recapture_requests
       WHERE user_id = $1
    `;
    const params = [userId];

    if (empIdParam) {
      query += ` AND emp_id = $2`;
      params.push(empIdParam);
    }

    query += ` ORDER BY created_at DESC LIMIT 1`;

    const { rows } = await pool.query(query, params);

    if (!rows.length) {
      return res.json({ success: true, request: null, status: null });
    }

    return res.json({ success: true, request: rows[0], status: rows[0].status });
  } catch (error) {
    console.error("[FaceRequest] status error:", error);
    return res.status(500).json({ success: false, error: "Server error", details: error.message });
  }
});

module.exports = router;
