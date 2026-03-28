const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/permissionMiddleware");

// 🟢 Fetch summary of all defined geofences
router.get("/summary", authenticate, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT g.geofence_id, g.zone_id, g.ward_id, g.latitude, g.longitude, g.radius, g.unit,
                   z.zone_name, c.city_name, w.ward_name
            FROM geofencing g
            LEFT JOIN zones z ON g.zone_id = z.zone_id
            LEFT JOIN cities c ON z.city_id = c.city_id
            LEFT JOIN wards w ON g.ward_id = w.ward_id
            ORDER BY c.city_name, z.zone_name, w.ward_name, g.geofence_id
        `);
        console.log("Summary data returned:", result.rows);
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching geofencing summary:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// 🟢 Fetch geofencing rules for a specific zone or ward
router.get("/", authenticate, async (req, res) => {
    const { zoneId, wardId } = req.query;
    try {
        let query = "SELECT * FROM geofencing WHERE ";
        let params = [];

        if (wardId) {
            query += "ward_id = $1";
            params.push(wardId);
        } else if (zoneId) {
            query += "zone_id = $1 AND ward_id IS NULL";
            params.push(zoneId);
        } else {
            return res.status(400).json({ error: "Zone ID or Ward ID is required" });
        }

        const result = await pool.query(query + " ORDER BY geofence_id ASC", params);
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching geofencing:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// Backward compatibility or direct access by zoneId
router.get("/zone/:zoneId", authenticate, async (req, res) => {
    const { zoneId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM geofencing WHERE zone_id = $1 AND ward_id IS NULL ORDER BY geofence_id ASC",
            [zoneId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching geofencing:", error);
        res.status(500).json({ error: "Database error" });
    }
});

router.get("/ward/:wardId", authenticate, async (req, res) => {
    const { wardId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM geofencing WHERE ward_id = $1 ORDER BY geofence_id ASC",
            [wardId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching geofencing:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// 🟢 Save or Update geofencing rules
router.post("/", authenticate, authorize("master", "manage"), async (req, res) => {
    const { zone_id, ward_id, fences } = req.body;

    if ((!zone_id && !ward_id) || !Array.isArray(fences)) {
        return res.status(400).json({ error: "Zone ID/Ward ID and an array of fences are required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Delete existing rules
        if (ward_id) {
            await client.query("DELETE FROM geofencing WHERE ward_id = $1", [ward_id]);
        } else {
            await client.query("DELETE FROM geofencing WHERE zone_id = $1 AND ward_id IS NULL", [zone_id]);
        }

        // 2. Insert new rules
        for (const fence of fences) {
            const { latitude, longitude, radius, unit } = fence;
            if (latitude && longitude && radius) {
                await client.query(
                    `INSERT INTO geofencing (zone_id, ward_id, latitude, longitude, radius, unit) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [zone_id || null, ward_id || null, latitude, longitude, radius, unit || 'meters']
                );
            }
        }

        await client.query("COMMIT");
        res.json({ message: "Geofencing rules updated successfully" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error saving geofencing:", error);
        res.status(500).json({ error: "Database error" });
    } finally {
        client.release();
    }
});

// 🟢 Delete all geofences for a specific group
router.delete("/group", authenticate, authorize("master", "manage"), async (req, res) => {
    const { zone_id, ward_id } = req.query;

    if (!zone_id && !ward_id) {
        return res.status(400).json({ error: "Zone ID or Ward ID is required" });
    }

    try {
        if (ward_id) {
            await pool.query("DELETE FROM geofencing WHERE ward_id = $1", [ward_id]);
        } else {
            await pool.query("DELETE FROM geofencing WHERE zone_id = $1 AND ward_id IS NULL", [zone_id]);
        }
        res.json({ message: "Geofencing group deleted successfully" });
    } catch (error) {
        console.error("Error deleting geofencing group:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// ============================================================
// 🚨 GEOFENCING REQUESTS
// ============================================================

const multer = require("multer");
const path = require("path");
const fs = require("fs");

const requestUploadsDir = path.join(__dirname, "../uploads/geofence_requests");
if (!fs.existsSync(requestUploadsDir)) {
    fs.mkdirSync(requestUploadsDir, { recursive: true });
}

const requestUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, requestUploadsDir),
        filename: (req, file, cb) => {
            const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
            cb(null, `geofence-req-${unique}${path.extname(file.originalname)}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed"));
        }
    }
});

// POST /api/geofencing/request — supervisor submits geofence setup request
// ✅ FIX: multer errors are caught properly and returned as JSON (prevents request hanging)
router.post("/request", authenticate, (req, res, next) => {
    requestUpload.single("photo")(req, res, (err) => {
        if (err) {
            console.error("[Geofence Request] Multer upload error:", err.message);
            return res.status(400).json({ error: err.message || "File upload failed" });
        }
        next();
    });
}, async (req, res) => {
    const { supervisor_name, phone_number, latitude, longitude, message, zone_id, ward_id } = req.body;
    const input_emp_id = req.body.emp_id || req.user?.emp_id || req.user?.user_id || req.user?.id || null;
    const photo_url = req.file ? `/uploads/geofence_requests/${req.file.filename}` : null;

    if (!supervisor_name) {
        return res.status(400).json({ error: "Supervisor name is required" });
    }

    let emp_id = null;

    try {
        if (input_emp_id) {
            // Check if input_emp_id already exists in employee table
            const empCheck = await pool.query('SELECT emp_id FROM employee WHERE emp_id = $1', [input_emp_id]);
            if (empCheck.rows.length > 0) {
                emp_id = empCheck.rows[0].emp_id;
            } else {
                // Otherwise treat it as user_id and find the joined emp_code
                const userCheck = await pool.query('SELECT emp_code FROM users WHERE user_id = $1', [input_emp_id]);
                if (userCheck.rows.length > 0 && userCheck.rows[0].emp_code) {
                    const mappedEmpCheck = await pool.query('SELECT emp_id FROM employee WHERE emp_code = $1', [userCheck.rows[0].emp_code]);
                    if (mappedEmpCheck.rows.length > 0) {
                        emp_id = mappedEmpCheck.rows[0].emp_id;
                    }
                }
            }
        }
        // Allow only one active request per supervisor; if rejected, they may apply again.
        if (emp_id) {
            const existing = await pool.query(
                `SELECT status, id FROM geofencing_requests 
                 WHERE emp_id = $1 
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [emp_id]
            );

            const last = existing.rows[0];
            if (last && (last.status === 'pending' || last.status === 'approved')) {
                return res.status(400).json({
                    error: "You already have an active geofence request. Please wait for it to be reviewed.",
                    requestId: last.id,
                });
            }
        }

        const result = await pool.query(
            `INSERT INTO geofencing_requests 
             (emp_id, zone_id, ward_id, supervisor_name, phone_number, latitude, longitude, photo_url, message, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
             RETURNING *`,
            [emp_id || null, zone_id || null, ward_id || null, supervisor_name, phone_number || null, latitude || null, longitude || null, photo_url, message || null]
        );
        res.status(201).json({ message: "Request submitted successfully", request: result.rows[0] });
    } catch (error) {
        console.error("Error submitting geofencing request:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// GET /api/geofencing/my-request — supervisor checks their own request status
router.get("/my-request", authenticate, async (req, res) => {
    const emp_id = req.user?.emp_id || req.user?.user_id || req.user?.id || null;

    try {
        if (!emp_id) {
            return res.json(null);
        }

        const result = await pool.query(
            "SELECT * FROM geofencing_requests WHERE emp_id = $1 ORDER BY created_at DESC LIMIT 1",
            [emp_id]
        );
        res.json(result.rows[0] || null);
    } catch (error) {
        console.error("Error fetching my geofence request:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// GET /api/geofencing/requests — admin fetches all pending requests
router.get("/requests", authenticate, async (req, res) => {
    console.log("GET /api/geofencing/requests - fetching all requests");
    try {
        const result = await pool.query(`
            SELECT gr.*, 
                   e.name AS emp_name, e.emp_code,
                   z.zone_name, w.ward_name, c.city_name
            FROM geofencing_requests gr
            LEFT JOIN employee e ON gr.emp_id = e.emp_id
            LEFT JOIN zones z ON gr.zone_id = z.zone_id
            LEFT JOIN wards w ON gr.ward_id = w.ward_id
            LEFT JOIN cities c ON z.city_id = c.city_id
            ORDER BY gr.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error("Error fetching geofencing requests:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// PATCH /api/geofencing/requests/:id — admin approves or rejects request
router.patch("/requests/:id", authenticate, authorize("master", "manage"), async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'approved' or 'rejected'

    if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({ error: "Status must be 'approved' or 'rejected'" });
    }

    try {
        const result = await pool.query(
            `UPDATE geofencing_requests 
             SET status = $1, reviewed_at = NOW(), reviewed_by = $2
             WHERE id = $3 RETURNING *`,
            [status, req.user?.id || null, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Request not found" });
        }

        const updatedRequest = result.rows[0];

        // Resolve ward/zone if missing: prefer payload → request → employee record
        let finalWardId = req.body.ward_id || updatedRequest.ward_id;
        let finalZoneId = req.body.zone_id || updatedRequest.zone_id;

        if ((!finalWardId || !finalZoneId) && updatedRequest.emp_id) {
            try {
                const empLookup = await pool.query(
                    "SELECT ward_id, zone_id FROM employee WHERE emp_id = $1 LIMIT 1",
                    [updatedRequest.emp_id]
                );
                if (empLookup.rows.length > 0) {
                    finalWardId = finalWardId || empLookup.rows[0].ward_id || null;
                    finalZoneId = finalZoneId || empLookup.rows[0].zone_id || null;
                }
            } catch (lookupErr) {
                console.warn("Geofence approval: could not resolve employee ward/zone", lookupErr);
            }
        }

        // 📍 If approved, automatically create a geofence rule using the coordinates from the request
        if (status === "approved" && updatedRequest.latitude && updatedRequest.longitude) {
            try {
                // Check if fence already exists for this ward/zone to avoid duplicates
                const existing = await pool.query(
                    "SELECT geofence_id FROM geofencing WHERE ward_id = $1 AND latitude = $2 AND longitude = $3",
                    [finalWardId, updatedRequest.latitude, updatedRequest.longitude]
                );

                if (existing.rows.length === 0) {
                    // Default to 150m radius for safety
                    await pool.query(
                        `INSERT INTO geofencing (zone_id, ward_id, latitude, longitude, radius, unit)
                        VALUES ($1, $2, $3, $4, $5, $6)`,
                        [finalZoneId || null, finalWardId || null, updatedRequest.latitude, updatedRequest.longitude, 150, 'meters']
                    );
                    console.log(`✅ Auto-created geofence for ward ${finalWardId} upon approval.`);
                }
            } catch (autoErr) {
                console.error("Failed to auto-create geofence entry:", autoErr);
            }
        }

        res.json({ message: `Request ${status} successfully`, request: updatedRequest });
    } catch (error) {
        console.error("Error reviewing geofencing request:", error);
        res.status(500).json({ error: "Database error" });
    }
});

// DELETE /api/geofencing/requests/:id — admin deletes a request (and matching geofence if it was auto-created)
router.delete("/requests/:id", authenticate, authorize("master", "manage"), async (req, res) => {
    const { id } = req.params;
    try {
        const existing = await pool.query("SELECT * FROM geofencing_requests WHERE id = $1", [id]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: "Request not found" });
        }
        const reqRow = existing.rows[0];

        // Remove matching geofence entry if it was created with the same ward/coords
        if (reqRow.ward_id && reqRow.latitude && reqRow.longitude) {
            await pool.query(
                "DELETE FROM geofencing WHERE ward_id = $1 AND latitude = $2 AND longitude = $3",
                [reqRow.ward_id, reqRow.latitude, reqRow.longitude]
            );
        }

        await pool.query("DELETE FROM geofencing_requests WHERE id = $1", [id]);
        res.json({ message: "Geofence request deleted" });
    } catch (error) {
        console.error("Error deleting geofencing request:", error);
        res.status(500).json({ error: "Database error" });
    }
});

module.exports = router;
