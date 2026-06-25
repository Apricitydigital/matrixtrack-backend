const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const authenticateUser = require("../middleware/authMiddleware");

// ╔══════════════════════════════════════════════════╗
// ║  SUPER ADMIN — NEVER DELETE OR BLOCK THIS EMAIL  ║
// ╚══════════════════════════════════════════════════╝
const SUPER_ADMIN_EMAIL = "admin@gmail.com";

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  const userRole = req.user?.role;
  if (!userRole || userRole.toLowerCase() !== "admin") {
    return res.status(403).json({ error: "Access denied. Admin role required." });
  }
  next();
};

router.use(authenticateUser);
router.use(requireAdmin);

// Fetch all admins
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, name, emp_code, email, phone, role, permissions, created_at 
       FROM users 
       WHERE role = 'admin' AND is_deleted = FALSE
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching admins:", error);
    res.status(500).json({ error: "Failed to fetch admins" });
  }
});

// Create a new admin
router.post("/", async (req, res) => {
  try {
    const { name, email, password, phone, permissions, emp_code } = req.body;

    // Simple validation
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    // emp_code generator logic or use provided code
    const empCode = emp_code && emp_code.trim() !== ""
      ? emp_code.trim()
      : ("ADM-" + Date.now().toString().slice(-6));

    const { rows } = await pool.query(
      `INSERT INTO users (name, emp_code, email, phone, role, password_hash, permissions)
       VALUES ($1, $2, $3, $4, 'admin', $5, $6)
       RETURNING user_id, name, emp_code, email, phone, role, permissions, created_at`,
      [name, empCode, email, phone || null, password_hash, permissions || null]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: "Email or Employee code already exists" });
    }
    console.error("Error creating admin:", error);
    res.status(500).json({ error: "Failed to create admin" });
  }
});

// Update an existing admin's permissions
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions, name, phone, emp_code } = req.body;

    // Safety: never allow changing core details of super admin via this route
    const targetCheck = await pool.query("SELECT email FROM users WHERE user_id = $1", [id]);
    const targetEmail = targetCheck.rows[0]?.email;
    if (targetEmail === SUPER_ADMIN_EMAIL) {
      // Allow name/phone update but NEVER touch permissions of super admin
      const { rows } = await pool.query(
        `UPDATE users 
         SET name = COALESCE($1, name),
             phone = COALESCE($2, phone)
         WHERE user_id = $3 AND role = 'admin'
         RETURNING user_id, name, emp_code, email, phone, role, permissions, created_at`,
        [name, phone, id]
      );
      return res.json(rows[0]);
    }

    const { rows } = await pool.query(
      `UPDATE users 
       SET permissions = COALESCE($1, permissions),
           name = COALESCE($2, name),
           phone = COALESCE($3, phone),
           emp_code = COALESCE($4, emp_code)
       WHERE user_id = $5 AND role = 'admin'
       RETURNING user_id, name, emp_code, email, phone, role, permissions, created_at`,
      [permissions, name, phone, emp_code && emp_code.trim() !== "" ? emp_code.trim() : null, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Admin not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: "Employee code already exists" });
    }
    console.error("Error updating admin:", error);
    res.status(500).json({ error: "Failed to update admin" });
  }
});

// Delete an admin (Soft Delete)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Only admin@gmail.com can delete other admins
    const initiatorRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [req.user.user_id]);
    const initiatorEmail = initiatorRes.rows[0]?.email;
    if (initiatorEmail !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ error: "Only the super admin is authorized to delete admins." });
    }

    // 2. NEVER allow deleting admin@gmail.com — from any angle
    const targetRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [id]);
    const targetEmail = targetRes.rows[0]?.email;
    if (targetEmail === SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ error: "The super admin account cannot be deleted." });
    }

    // 3. Extra safety: self-delete prevention by user_id
    if (String(id) === String(req.user.user_id)) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }

    // 4. Soft delete
    const deleteRes = await pool.query(
      `UPDATE users 
       SET is_deleted = TRUE, deleted_at = NOW() 
       WHERE user_id = $1 AND role = 'admin' AND is_deleted = FALSE 
       RETURNING user_id`,
      [id]
    );
    if (deleteRes.rowCount === 0) {
      return res.status(404).json({ error: "Admin not found or already deleted." });
    }

    res.json({ message: "Admin deleted successfully. Account can be recovered within 7 days." });
  } catch (error) {
    console.error("Error deleting admin:", error);
    res.status(500).json({ error: "Failed to delete admin" });
  }
});

// Dynamic log enrichment function for fetch endpoint
const enrichLogs = async (logs) => {
  if (!Array.isArray(logs) || logs.length === 0) return logs;

  const userIds = new Set();
  const wardIds = new Set();
  const sectorIds = new Set();
  const cityIds = new Set();
  const zoneIds = new Set();
  const deptIds = new Set();
  const desigIds = new Set();

  const addId = (set, val) => {
    if (val !== undefined && val !== null && !isNaN(val)) {
      set.add(parseInt(val, 10));
    }
  };

  logs.forEach(log => {
    const payload = log.action?.payload;
    if (payload && typeof payload === 'object') {
      addId(userIds, payload.user_id || payload.supervisor_id || payload.userId || payload.supervisorId);
      addId(wardIds, payload.ward_id || payload.wardId);
      addId(sectorIds, payload.sector_id || payload.sectorId);
      addId(cityIds, payload.city_id || payload.cityId);
      addId(zoneIds, payload.zone_id || payload.zoneId);
      addId(deptIds, payload.department_id || payload.departmentId);
      addId(desigIds, payload.designation_id || payload.designationId);
    }
  });

  const maps = {
    users: {},
    wards: {},
    sectors: {},
    cities: {},
    zones: {},
    departments: {},
    designations: {}
  };

  try {
    await Promise.all([
      userIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT user_id, name FROM users WHERE user_id = ANY($1::int[])",
          [[...userIds]]
        );
        res.rows.forEach(r => { maps.users[r.user_id] = r.name; });
      })() : Promise.resolve(),

      wardIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT ward_id, ward_name FROM wards WHERE ward_id = ANY($1::int[])",
          [[...wardIds]]
        );
        res.rows.forEach(r => { maps.wards[r.ward_id] = r.ward_name; });
      })() : Promise.resolve(),

      sectorIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT sector_id, sector_name FROM sectors WHERE sector_id = ANY($1::int[])",
          [[...sectorIds]]
        );
        res.rows.forEach(r => { maps.sectors[r.sector_id] = r.sector_name; });
      })() : Promise.resolve(),

      cityIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT city_id, city_name FROM cities WHERE city_id = ANY($1::int[])",
          [[...cityIds]]
        );
        res.rows.forEach(r => { maps.cities[r.city_id] = r.city_name; });
      })() : Promise.resolve(),

      zoneIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT zone_id, zone_name FROM zones WHERE zone_id = ANY($1::int[])",
          [[...zoneIds]]
        );
        res.rows.forEach(r => { maps.zones[r.zone_id] = r.zone_name; });
      })() : Promise.resolve(),

      deptIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT department_id, department_name FROM department WHERE department_id = ANY($1::int[])",
          [[...deptIds]]
        );
        res.rows.forEach(r => { maps.departments[r.department_id] = r.department_name; });
      })() : Promise.resolve(),

      desigIds.size > 0 ? (async () => {
        const res = await pool.query(
          "SELECT designation_id, designation_name FROM designation WHERE designation_id = ANY($1::int[])",
          [[...desigIds]]
        );
        res.rows.forEach(r => { maps.designations[r.designation_id] = r.designation_name; });
      })() : Promise.resolve()
    ]);
  } catch (dbErr) {
    console.error("[audit-logs] DB lookup error during dynamic enrichment:", dbErr.message);
  }

  return logs.map(log => {
    if (!log.action?.payload || typeof log.action.payload !== 'object') return log;
    
    // Clone log structure
    const clonedLog = JSON.parse(JSON.stringify(log));
    const payload = clonedLog.action.payload;

    const tryEnrich = (val, map) => {
      if (val !== undefined && val !== null && !isNaN(val)) {
        const id = parseInt(val, 10);
        if (map[id]) return map[id];
      }
      return val;
    };

    if (payload.user_id) payload.user_id = tryEnrich(payload.user_id, maps.users);
    if (payload.userId) payload.userId = tryEnrich(payload.userId, maps.users);
    if (payload.supervisor_id) payload.supervisor_id = tryEnrich(payload.supervisor_id, maps.users);
    if (payload.supervisorId) payload.supervisorId = tryEnrich(payload.supervisorId, maps.users);

    if (payload.ward_id) payload.ward_id = tryEnrich(payload.ward_id, maps.wards);
    if (payload.wardId) payload.wardId = tryEnrich(payload.wardId, maps.wards);

    if (payload.sector_id) payload.sector_id = tryEnrich(payload.sector_id, maps.sectors);
    if (payload.sectorId) payload.sectorId = tryEnrich(payload.sectorId, maps.sectors);

    if (payload.city_id) payload.city_id = tryEnrich(payload.city_id, maps.cities);
    if (payload.cityId) payload.cityId = tryEnrich(payload.cityId, maps.cities);

    if (payload.zone_id) payload.zone_id = tryEnrich(payload.zone_id, maps.zones);
    if (payload.zoneId) payload.zoneId = tryEnrich(payload.zoneId, maps.zones);

    if (payload.department_id) payload.department_id = tryEnrich(payload.department_id, maps.departments);
    if (payload.departmentId) payload.departmentId = tryEnrich(payload.departmentId, maps.departments);

    if (payload.designation_id) payload.designation_id = tryEnrich(payload.designation_id, maps.designations);
    if (payload.designationId) payload.designationId = tryEnrich(payload.designationId, maps.designations);

    return clonedLog;
  });
};

// Fetch S3 activity logs for a given date
router.get("/audit-logs", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Date parameter is required (format: YYYY-MM-DD)" });
    }

    // Safety check: Only active admins can fetch logs
    const initiatorRes = await pool.query("SELECT email FROM users WHERE user_id = $1", [req.user.user_id]);
    const initiatorEmail = initiatorRes.rows[0]?.email;
    if (!initiatorEmail) {
      return res.status(403).json({ error: "Access denied. Valid admin login required." });
    }

    const { fetchAuditLogsForDate } = require("../utils/s3Logger");
    const rawLogs = await fetchAuditLogsForDate(date);
    const enrichedLogs = await enrichLogs(rawLogs);
    res.json(enrichedLogs);
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

// Generic logging endpoints for admin module
router.post("/log-page-visit", async (req, res) => {
  res.json({ success: true, message: "Page visit logged" });
});

router.post("/log-action", async (req, res) => {
  res.json({ success: true, message: "Custom action logged" });
});

module.exports = router;
