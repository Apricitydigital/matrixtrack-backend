const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const authenticateUser = require("../middleware/authMiddleware");

// ╔══════════════════════════════════════════════════╗
// ║  SUPER ADMIN — NEVER DELETE OR BLOCK THIS EMAIL  ║
// ╚══════════════════════════════════════════════════╝
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "mtadmin@apricitydigital.in";

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
      `SELECT user_id, name, emp_code, email, phone, role, permissions, custom_login_policy, custom_max_devices, created_at 
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
    const { name, email, password, phone, permissions, emp_code, custom_login_policy, custom_max_devices } = req.body;

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
      `INSERT INTO users (name, emp_code, email, phone, role, password_hash, permissions, custom_login_policy, custom_max_devices)
       VALUES ($1, $2, $3, $4, 'admin', $5, $6, $7, $8)
       RETURNING user_id, name, emp_code, email, phone, role, permissions, custom_login_policy, custom_max_devices, created_at`,
      [name, empCode, email, phone || null, password_hash, permissions || null, custom_login_policy || null, custom_max_devices || null]
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

// Update an existing admin's details & permissions
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions, name, email, phone, emp_code, password, custom_login_policy, custom_max_devices } = req.body;

    // Safety: never allow changing core details of super admin via this route
    const targetCheck = await pool.query("SELECT email FROM users WHERE user_id = $1", [id]);
    if (targetCheck.rows.length === 0) {
      return res.status(404).json({ error: "Admin not found" });
    }
    const targetEmail = targetCheck.rows[0]?.email;

    if (email && email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    let queryText = "";
    let queryParams = [];

    if (password && password.trim() !== "") {
      const salt = await bcrypt.genSalt(10);
      const password_hash = await bcrypt.hash(password, salt);

      if (targetEmail === SUPER_ADMIN_EMAIL) {
        queryText = `UPDATE users 
                     SET name = COALESCE($1, name),
                         phone = COALESCE($2, phone),
                         password_hash = $3
                     WHERE user_id = $4 AND role = 'admin'
                     RETURNING user_id, name, emp_code, email, phone, role, permissions, custom_login_policy, custom_max_devices, created_at`;
        queryParams = [name, phone, password_hash, id];
      } else {
        queryText = `UPDATE users 
                     SET permissions = COALESCE($1, permissions),
                         name = COALESCE($2, name),
                         email = COALESCE($3, email),
                         phone = COALESCE($4, phone),
                         emp_code = COALESCE($5, emp_code),
                         password_hash = $6,
                         custom_login_policy = $7,
                         custom_max_devices = $8
                     WHERE user_id = $9 AND role = 'admin'
                     RETURNING user_id, name, emp_code, email, phone, role, permissions, custom_login_policy, custom_max_devices, created_at`;
        queryParams = [
          permissions,
          name,
          email && email.trim() !== "" ? email.trim() : null,
          phone,
          emp_code && emp_code.trim() !== "" ? emp_code.trim() : null,
          password_hash,
          custom_login_policy || null,
          custom_max_devices || null,
          id
        ];
      }
    } else {
      if (targetEmail === SUPER_ADMIN_EMAIL) {
        queryText = `UPDATE users 
                     SET name = COALESCE($1, name),
                         phone = COALESCE($2, phone)
                     WHERE user_id = $3 AND role = 'admin'
                     RETURNING user_id, name, emp_code, email, phone, role, permissions, custom_login_policy, custom_max_devices, created_at`;
        queryParams = [name, phone, id];
      } else {
        queryText = `UPDATE users 
                     SET permissions = COALESCE($1, permissions),
                         name = COALESCE($2, name),
                         email = COALESCE($3, email),
                         phone = COALESCE($4, phone),
                         emp_code = COALESCE($5, emp_code),
                         custom_login_policy = $6,
                         custom_max_devices = $7
                     WHERE user_id = $8 AND role = 'admin'
                     RETURNING user_id, name, emp_code, email, phone, role, permissions, custom_login_policy, custom_max_devices, created_at`;
        queryParams = [
          permissions,
          name,
          email && email.trim() !== "" ? email.trim() : null,
          phone,
          emp_code && emp_code.trim() !== "" ? emp_code.trim() : null,
          custom_login_policy || null,
          custom_max_devices || null,
          id
        ];
      }
    }

    const { rows } = await pool.query(queryText, queryParams);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Admin not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: "Email or Employee code already exists" });
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

// Get list of blocked IPs
router.get("/blocked-ips", async (req, res) => {
  try {
    // Only admins can view blocked IPs
    const userRole = req.user?.role;
    if (!userRole || userRole.toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Access denied. Admin role required." });
    }

    const { rows } = await pool.query(
      `SELECT b.ip_address, b.reason, b.blocked_at, u.name as blocked_by_name 
       FROM blocked_ips b 
       LEFT JOIN users u ON b.blocked_by = u.user_id 
       ORDER BY b.blocked_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching blocked IPs:", error);
    res.status(500).json({ error: "Failed to fetch blocked IPs" });
  }
});

// Helper function to check if caller has IP blocking permissions
const checkIpBlockPermission = async (userId) => {
  const { rows } = await pool.query(
    "SELECT email, role, permissions FROM users WHERE user_id = $1 AND is_deleted = FALSE",
    [userId]
  );
  if (rows.length === 0) return false;
  const user = rows[0];
  if (user.email === SUPER_ADMIN_EMAIL) return true; // Super admin always allowed
  if (user.role?.toLowerCase() === "admin") {
    if (user.permissions && user.permissions.role_type === "super_admin") return true;
    if (user.permissions && user.permissions.actions && user.permissions.actions.can_block_ip === true) {
      return true;
    }
  }
  return false;
};

// Block an IP address
router.post("/block-ip", async (req, res) => {
  try {
    const hasPerm = await checkIpBlockPermission(req.user.user_id);
    if (!hasPerm) {
      return res.status(403).json({ error: "Access denied. You do not have permission to block IPs." });
    }

    const { ip, reason } = req.body;
    if (!ip) {
      return res.status(400).json({ error: "IP address is required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO blocked_ips (ip_address, blocked_by, reason) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (ip_address) 
       DO UPDATE SET blocked_by = EXCLUDED.blocked_by, reason = EXCLUDED.reason, blocked_at = NOW() 
       RETURNING *`,
      [ip, req.user.user_id, reason || null]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error("Error blocking IP:", error);
    res.status(500).json({ error: "Failed to block IP" });
  }
});

// Unblock an IP address
router.delete("/block-ip/:ip", async (req, res) => {
  try {
    const hasPerm = await checkIpBlockPermission(req.user.user_id);
    if (!hasPerm) {
      return res.status(403).json({ error: "Access denied. You do not have permission to unblock IPs." });
    }

    const { ip } = req.params;
    if (!ip) {
      return res.status(400).json({ error: "IP address is required" });
    }

    const { rowCount } = await pool.query(
      "DELETE FROM blocked_ips WHERE ip_address = $1",
      [ip]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "IP address not found in blocked list" });
    }

    res.json({ success: true, message: "IP address unblocked successfully" });
  } catch (error) {
    console.error("Error unblocking IP:", error);
    res.status(500).json({ error: "Failed to unblock IP" });
  }
});

// ══════════════════════════════════════════════════
// FORCE LOGOUT / ACTIVE SESSIONS ENDPOINTS
// ══════════════════════════════════════════════════

// Middleware to check super admin
const requireSuperAdmin = (req, res, next) => {
  const email = (req.user?.email || "").toLowerCase();
  const isSuperEmail = email === SUPER_ADMIN_EMAIL.toLowerCase() || email === "admin@gmail.com";
  const isSuperRole = req.user?.role === 'super_admin' || req.user?.customPermissions?.role_type === 'super_admin';
  if (isSuperEmail || isSuperRole) {
     next();
  } else {
     pool.query("SELECT email, role, permissions FROM users WHERE user_id = $1", [req.user?.user_id])
       .then(result => {
          const u = result.rows[0];
          const dbEmail = (u?.email || "").toLowerCase();
          if (u && (dbEmail === SUPER_ADMIN_EMAIL.toLowerCase() || dbEmail === "admin@gmail.com" || u.role === 'super_admin' || u.permissions?.role_type === 'super_admin')) {
             next();
          } else {
             res.status(403).json({ error: "Access denied. Super Admin role required for this action." });
          }
       })
       .catch(err => {
          console.error("Super admin check error:", err);
          res.status(500).json({ error: "Internal server error during authorization check." });
       });
  }
};

// GET /api/admin-management/active-sessions
router.get("/active-sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         s.id as session_id,
         s.user_id,
         s.ip_address,
         s.device,
         s.logged_in_at,
         u.name as admin_name,
         u.email as admin_email,
         u.role as admin_role
       FROM active_sessions s
       JOIN users u ON s.user_id = u.user_id
       WHERE s.is_revoked = FALSE
       ORDER BY s.logged_in_at DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching active sessions:", error);
    res.status(500).json({ error: "Failed to fetch active sessions" });
  }
});

// POST /api/admin-management/force-logout/:sessionId
router.post("/force-logout/:sessionId", requireSuperAdmin, async (req, res) => {
  const { sessionId } = req.params;
  try {
    // Get session info for audit log before deleting
    const sessionCheck = await pool.query(
      `SELECT s.user_id, u.name, u.email 
       FROM active_sessions s 
       JOIN users u ON s.user_id = u.user_id 
       WHERE s.id = $1 AND s.is_revoked = FALSE`,
      [sessionId]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ error: "Active session not found or already revoked." });
    }

    const targetUser = sessionCheck.rows[0];

    // Prevent super admin from force logging out themselves
    if (targetUser.user_id === req.user.user_id) {
       return res.status(400).json({ error: "You cannot force logout your own session here." });
    }
    
    // Cannot force logout another super admin (optional security measure, but good practice)
    if (targetUser.email === SUPER_ADMIN_EMAIL) {
       return res.status(403).json({ error: "Cannot force logout the primary Super Admin." });
    }

    // Revoke the session
    await pool.query(
      `UPDATE active_sessions 
       SET is_revoked = TRUE, revoked_by = $1, revoked_at = NOW() 
       WHERE id = $2`,
      [req.user.user_id, sessionId]
    );

    // Add to audit log
    try {
        const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || "unknown";
        await pool.query(
          `INSERT INTO activity_logs (user_id, action, details, ip_address, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            req.user.user_id,
            "FORCE_LOGOUT",
            `Force logged out session ID ${sessionId} for admin ${targetUser.name} (${targetUser.email})`,
            clientIp
          ]
        );
    } catch(auditErr) {
        console.error("Warning: Failed to log force logout to activity_logs:", auditErr.message);
    }

    res.json({ message: "Session terminated successfully." });
  } catch (error) {
    console.error("Error force logging out session:", error);
    res.status(500).json({ error: "Failed to force logout session" });
  }
});

// POST /api/admin-management/force-logout-user/:userId
router.post("/force-logout-user/:userId", requireSuperAdmin, async (req, res) => {
  const { userId } = req.params;
  try {
    const userCheck = await pool.query(
      "SELECT name, email FROM users WHERE user_id = $1",
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const targetUser = userCheck.rows[0];

    if (targetUser.email === SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ error: "Cannot force logout sessions for primary Super Admin." });
    }

    const updateRes = await pool.query(
      `UPDATE active_sessions 
       SET is_revoked = TRUE, revoked_by = $1, revoked_at = NOW() 
       WHERE user_id = $2 AND is_revoked = FALSE AND (user_id != $1 OR id != COALESCE((SELECT id FROM active_sessions WHERE user_id = $1 ORDER BY logged_in_at DESC LIMIT 1), -1))
       RETURNING id`,
      [req.user.user_id, userId]
    );

    const revokedCount = updateRes.rowCount;

    try {
      const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || "unknown";
      await pool.query(
        `INSERT INTO activity_logs (user_id, action, details, ip_address, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          req.user.user_id,
          "FORCE_LOGOUT_ALL_USER",
          `Force logged out all ${revokedCount} session(s) for user ${targetUser.name} (${targetUser.email})`,
          clientIp
        ]
      );
    } catch(auditErr) {
      console.error("Warning: Failed to log user force logout to activity_logs:", auditErr.message);
    }

    res.json({ message: `Successfully terminated all ${revokedCount} session(s) for ${targetUser.name}.`, count: revokedCount });
  } catch (error) {
    console.error("Error force logging out all sessions for user:", error);
    res.status(500).json({ error: "Failed to revoke all user sessions" });
  }
});

// POST /api/admin-management/force-logout-bulk
router.post("/force-logout-bulk", requireSuperAdmin, async (req, res) => {
  const { sessionIds } = req.body;
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: "No session IDs provided for bulk termination." });
  }

  try {
    const updateRes = await pool.query(
      `UPDATE active_sessions 
       SET is_revoked = TRUE, revoked_by = $1, revoked_at = NOW() 
       WHERE id = ANY($2::int[]) AND is_revoked = FALSE
         AND user_id NOT IN (SELECT user_id FROM users WHERE email = $3)
       RETURNING id`,
      [req.user.user_id, sessionIds, SUPER_ADMIN_EMAIL]
    );

    const revokedCount = updateRes.rowCount;

    try {
      const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || "unknown";
      await pool.query(
        `INSERT INTO activity_logs (user_id, action, details, ip_address, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          req.user.user_id,
          "FORCE_LOGOUT_BULK",
          `Bulk force logged out ${revokedCount} session(s)`,
          clientIp
        ]
      );
    } catch(auditErr) {
      console.error("Warning: Failed to log bulk force logout to activity_logs:", auditErr.message);
    }

    res.json({ message: `Successfully terminated ${revokedCount} selected session(s).`, count: revokedCount });
  } catch (error) {
    console.error("Error performing bulk force logout:", error);
    res.status(500).json({ error: "Failed to perform bulk force logout" });
  }
});

// ══════════════════════════════════════════════════
// EXTERNAL API KEY MANAGEMENT
// ══════════════════════════════════════════════════
const { generateApiKey } = require("../utils/apiKeyUtils");
const { invalidateApiKeyCache } = require("../middleware/apiKeyAuth");

const resolveApiKeyScope = async ({ cityId, zoneId, wardId }) => {
  let resolvedCityId = cityId || null;
  let resolvedZoneId = zoneId || null;
  const resolvedWardId = wardId || null;

  if (resolvedWardId) {
    const { rows } = await pool.query(
      `SELECT w.ward_id, z.zone_id, z.city_id
       FROM wards w
       JOIN zones z ON w.zone_id = z.zone_id
       WHERE w.ward_id = $1`,
      [resolvedWardId]
    );
    if (rows.length === 0) throw new Error("INVALID_WARD_SCOPE");
    if (resolvedZoneId && String(resolvedZoneId) !== String(rows[0].zone_id)) {
      throw new Error("WARD_ZONE_SCOPE_MISMATCH");
    }
    if (resolvedCityId && String(resolvedCityId) !== String(rows[0].city_id)) {
      throw new Error("WARD_CITY_SCOPE_MISMATCH");
    }
    resolvedZoneId = rows[0].zone_id;
    resolvedCityId = rows[0].city_id;
  } else if (resolvedZoneId) {
    const { rows } = await pool.query(
      `SELECT zone_id, city_id FROM zones WHERE zone_id = $1`,
      [resolvedZoneId]
    );
    if (rows.length === 0) throw new Error("INVALID_ZONE_SCOPE");
    if (resolvedCityId && String(resolvedCityId) !== String(rows[0].city_id)) {
      throw new Error("ZONE_CITY_SCOPE_MISMATCH");
    }
    resolvedCityId = rows[0].city_id;
  } else if (resolvedCityId) {
    const { rows } = await pool.query(
      `SELECT city_id FROM cities WHERE city_id = $1`,
      [resolvedCityId]
    );
    if (rows.length === 0) throw new Error("INVALID_CITY_SCOPE");
  }

  return {
    cityId: resolvedCityId,
    zoneId: resolvedZoneId,
    wardId: resolvedWardId,
  };
};

// GET /api/admin-management/api-keys — List all API keys
router.get("/api-keys", requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         ak.id, ak.key_prefix, ak.full_key_secret, ak.name, ak.city_id, ak.zone_id, ak.ward_id,
         c.city_name, z.zone_name, w.ward_name,
         ak.scopes, ak.is_active, ak.rate_limit_per_minute,
         ak.allowed_ips, ak.last_used_at, ak.total_requests,
         ak.expires_at, ak.created_at,
         u.name AS created_by_name
       FROM api_keys ak
       LEFT JOIN cities c ON ak.city_id = c.city_id
       LEFT JOIN zones z ON ak.zone_id = z.zone_id
       LEFT JOIN wards w ON ak.ward_id = w.ward_id
       LEFT JOIN users u ON ak.created_by = u.user_id
       ORDER BY ak.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[API Keys] Error listing keys:", error);
    res.status(500).json({ error: "Failed to fetch API keys" });
  }
});

// POST /api/admin-management/api-keys — Create a new API key
router.post("/api-keys", requireSuperAdmin, async (req, res) => {
  try {
    const {
      name,
      city_id = null,
      zone_id = null,
      ward_id = null,
      scopes = ["attendance:read"],
      rate_limit_per_minute = 100,
      allowed_ips = null,
      expires_at = null,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Key name is required." });
    }

    let resolvedScope;
    try {
      resolvedScope = await resolveApiKeyScope({
        cityId: city_id,
        zoneId: zone_id,
        wardId: ward_id,
      });
    } catch (scopeError) {
      return res.status(400).json({
        error: "Selected city, zone, and ward must belong to the same hierarchy.",
        code: scopeError.message,
      });
    }

    const env = process.env.NODE_ENV === "production" ? "live" : "test";
    const { fullKey, prefix, hash } = generateApiKey(env);

    const { rows } = await pool.query(
      `INSERT INTO api_keys (key_hash, key_prefix, full_key_secret, name, created_by, city_id, zone_id, ward_id, scopes, rate_limit_per_minute, allowed_ips, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, key_prefix, full_key_secret, name, city_id, zone_id, ward_id, scopes, is_active, rate_limit_per_minute, allowed_ips, expires_at, created_at`,
      [
        hash,
        prefix,
        fullKey,
        name.trim(),
        req.user.user_id,
        resolvedScope.cityId,
        resolvedScope.zoneId,
        resolvedScope.wardId,
        scopes,
        rate_limit_per_minute,
        allowed_ips,
        expires_at,
      ]
    );

    res.status(201).json({
      success: true,
      message: "API key created successfully.",
      api_key: fullKey,
      data: rows[0],
    });
  } catch (error) {
    console.error("[API Keys] Error creating key:", error);
    res.status(500).json({ error: "Failed to create API key" });
  }
});

// PUT /api/admin-management/api-keys/:id — Update key settings (name, scopes, IPs, rate limit)
router.put("/api-keys/:id", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, scopes, rate_limit_per_minute, allowed_ips, expires_at, city_id } = req.body;

    const { rows } = await pool.query(
      `UPDATE api_keys SET
         name = COALESCE($1, name),
         scopes = COALESCE($2, scopes),
         rate_limit_per_minute = COALESCE($3, rate_limit_per_minute),
         allowed_ips = $4,
         expires_at = $5,
         city_id = $6,
         updated_at = NOW()
       WHERE id = $7
       RETURNING id, key_prefix, name, city_id, scopes, is_active, rate_limit_per_minute, allowed_ips, expires_at, updated_at`,
      [name, scopes, rate_limit_per_minute, allowed_ips || null, expires_at || null, city_id ?? null, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "API key not found." });
    }

    invalidateApiKeyCache();
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error("[API Keys] Error updating key:", error);
    res.status(500).json({ error: "Failed to update API key" });
  }
});

// POST /api/admin-management/api-keys/:id/revoke — Revoke an API key
router.post("/api-keys/:id/revoke", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `UPDATE api_keys SET is_active = false, updated_at = NOW()
       WHERE id = $1
       RETURNING id, key_prefix, name, is_active`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "API key not found." });
    }

    invalidateApiKeyCache();
    res.json({ success: true, message: "API key revoked.", data: rows[0] });
  } catch (error) {
    console.error("[API Keys] Error revoking key:", error);
    res.status(500).json({ error: "Failed to revoke API key" });
  }
});

// POST /api/admin-management/api-keys/:id/activate — Re-activate a revoked key
router.post("/api-keys/:id/activate", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `UPDATE api_keys SET is_active = true, updated_at = NOW()
       WHERE id = $1
       RETURNING id, key_prefix, name, is_active`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "API key not found." });
    }

    invalidateApiKeyCache();
    res.json({ success: true, message: "API key re-activated.", data: rows[0] });
  } catch (error) {
    console.error("[API Keys] Error activating key:", error);
    res.status(500).json({ error: "Failed to activate API key" });
  }
});

// DELETE /api/admin-management/api-keys/:id — Permanently delete a key
router.delete("/api-keys/:id", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await pool.query(
      `DELETE FROM api_keys WHERE id = $1`,
      [id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: "API key not found." });
    }

    invalidateApiKeyCache();
    res.json({ success: true, message: "API key permanently deleted." });
  } catch (error) {
    console.error("[API Keys] Error deleting key:", error);
    res.status(500).json({ error: "Failed to delete API key" });
  }
});

// GET /api/admin-management/api-keys/:id/usage — View usage logs for a key
router.get("/api-keys/:id/usage", requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const [keyResult, logsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, key_prefix, name, total_requests, last_used_at FROM api_keys WHERE id = $1`,
        [id]
      ),
      pool.query(
        `SELECT endpoint, method, response_status, ip_address, user_agent, created_at
         FROM api_key_usage_logs
         WHERE api_key_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) as total FROM api_key_usage_logs WHERE api_key_id = $1`,
        [id]
      ),
    ]);

    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: "API key not found." });
    }

    const total = parseInt(countResult.rows[0].total, 10);

    res.json({
      success: true,
      key: keyResult.rows[0],
      logs: logsResult.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("[API Keys] Error fetching usage:", error);
    res.status(500).json({ error: "Failed to fetch API key usage" });
  }
});

module.exports = router;
