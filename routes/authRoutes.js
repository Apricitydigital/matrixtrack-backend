const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware"); // ✅ Import middleware
const { fetchUserCityAccess } = require("../utils/userCityAccess");
const {
  ensureSelfAttendanceSupport,
  fetchEmployeeByCode,
} = require("../utils/selfAttendance");

const router = express.Router();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "45d";
const JWT_COOKIE_MAX_AGE_MS =
  Number(process.env.JWT_COOKIE_MAX_AGE_MS) || 45 * 24 * 60 * 60 * 1000;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "mtadmin@apricitydigital.in";

const getUserAccessProfile = async (userId) => {
  const rolesQuery = `
    SELECT r.id, r.name
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
  `;

  const permissionsQuery = `
    SELECT DISTINCT p.id, p.module, p.action, p.label, up.city_id
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = $1
    UNION
    SELECT DISTINCT p.id, p.module, p.action, p.label, NULL::int AS city_id
    FROM role_permissions rp
    JOIN user_roles ur ON ur.role_id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = $1
    ORDER BY module, action
  `;

  const [rolesResult, permissionsResult] = await Promise.all([
    pool.query(rolesQuery, [userId]),
    pool.query(permissionsQuery, [userId]),
  ]);

  return {
    roles: rolesResult.rows,
    permissions: permissionsResult.rows,
  };
};

const computeAllowedCities = async (userRow, access) => {
  const isAdminRole =
    (userRow?.role || "").toLowerCase() === "admin" ||
    access?.roles?.some(
      (role) => (role.name || "").toLowerCase() === "admin"
    );
  if (isAdminRole) {
    if (userRow?.permissions && Array.isArray(userRow.permissions.assigned_cities)) {
      return userRow.permissions.assigned_cities.map(Number);
    }
    return null; // all cities
  }

  const scope = await fetchUserCityAccess(userRow);
  if (scope.all) {
    return null;
  }

  const ids = Array.isArray(scope.ids) ? scope.ids : [];
  const list = ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  return list.length ? list : [];
};

const buildUiPermissions = (access) => {
  const permissions = access?.permissions || [];
  const hasDashboardCityFilter = permissions.some(
    (perm) =>
      perm?.module?.toLowerCase() === "dashboard" &&
      perm?.action?.toLowerCase() === "city_filter:view"
  );

  return {
    dashboard: {
      view:
        permissions.some(
          (perm) =>
            perm?.module?.toLowerCase() === "dashboard" &&
            perm?.action?.toLowerCase() === "view"
        ) || false,
      cityFilter: hasDashboardCityFilter,
    },
  };
};

const fetchEmployeeProfile = async (empCode) => {
  if (!empCode) {
    return null;
  }

  try {
    await ensureSelfAttendanceSupport();
    const employee = await fetchEmployeeByCode(empCode);
    if (!employee) {
      return null;
    }

    return {
      emp_id: employee.emp_id,
      emp_code: employee.emp_code,
      name: employee.name,
      ward_id: employee.ward_id,
      face_enrolled: Boolean(employee.face_embedding),
      self_attendance_enabled: Boolean(employee.self_attendance_enabled),
    };
  } catch (error) {
    console.error("Employee profile fetch error:", error);
    return null;
  }
};

// ✅ Get Logged-in User
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      "SELECT user_id, name, email, role, permissions, emp_code, phone FROM users WHERE user_id = $1",
      [req.user.user_id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const access = await getUserAccessProfile(req.user.user_id);

    const allowedCities = await computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);
    const employeeProfile = await fetchEmployeeProfile(user.rows[0].emp_code);

    res.json({
      ...user.rows[0],
      customPermissions: user.rows[0].permissions,
      access,
      allowedCities,
      uiPermissions,
      employee: employeeProfile,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Check duplicate fields
router.post("/check-duplicate", async (req, res) => {
  const { email, emp_code, phone, aadhar_number } = req.body;
  try {
    let emailExists = false;
    let empCodeExists = false;
    let phoneExists = false;
    let aadharExists = false;

    if (email) {
      const emailCheck = await pool.query("SELECT user_id FROM users WHERE email = $1 LIMIT 1", [email.trim().toLowerCase()]);
      emailExists = emailCheck.rowCount > 0;
    }
    if (emp_code) {
      const empCodeCheck = await pool.query("SELECT user_id FROM users WHERE emp_code = $1 LIMIT 1", [emp_code.trim()]);
      empCodeExists = empCodeCheck.rowCount > 0;
    }
    if (phone) {
      const phoneCheck = await pool.query("SELECT user_id FROM users WHERE phone = $1 LIMIT 1", [phone.trim()]);
      phoneExists = phoneCheck.rowCount > 0;
    }
    if (aadhar_number) {
      const aadharCheck = await pool.query("SELECT user_id FROM users WHERE aadhar_number = $1 LIMIT 1", [aadhar_number.trim()]);
      aadharExists = aadharCheck.rowCount > 0;
    }

    res.json({ emailExists, empCodeExists, phoneExists, aadharExists });
  } catch (error) {
    console.error("Duplicate check error:", error);
    res.status(500).json({ error: "Check failed" });
  }
});

// ✅ Create new User
router.post("/register", async (req, res) => {
  const { name, emp_code, email, phone, role, password } = req.body;

  if (!name || !emp_code || !email || !phone || !role || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const result = await pool.query(
      `INSERT INTO users (name, emp_code, email, phone, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING user_id, name, role`,
      [name, emp_code, email, phone, role, hashedPassword]
    );

    if (result.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        "SELECT user_id, name, role FROM users WHERE email = $1 OR emp_code = $2 LIMIT 1",
        [email, emp_code]
      );
      return res.status(200).json({
        message: "Record exists, skipping",
        user: existing.rows[0] || null,
      });
    }

    res.status(201).json({ message: "User registered", user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      console.warn("Record exists, skipping");
      return res.status(200).json({ message: "Record exists, skipping" });
    }
    res.status(500).json({ error: "Registration failed" });
  }
});

router.put("/update", async (req, res) => {
  const {
    user_id,
    name,
    emp_code,
    email,
    phone,
    role,
    passChange = false,
    password,
  } = req.body;

  if (!user_id || !name || !emp_code || !email || !phone || !role) {
    return res.status(400).json({ error: "All fields are required" });
  }

  if (passChange && !password) {
    return res
      .status(400)
      .json({ error: "Password is required when passChange is true" });
  }

  try {
    let queryText;
    let queryParams;

    if (passChange) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      queryText = `
        UPDATE users
        SET name = $2,
            emp_code = $3,
            email = $4,
            phone = $5,
            role = $6,
            password_hash = $7
        WHERE user_id = $1
        RETURNING user_id, name, emp_code, email, phone, role
      `;
      queryParams = [
        user_id,
        name,
        emp_code,
        email,
        phone,
        role,
        hashedPassword,
      ];
    } else {
      queryText = `
        UPDATE users
        SET name = $2,
            emp_code = $3,
            email = $4,
            phone = $5,
            role = $6
        WHERE user_id = $1
        RETURNING user_id, name, emp_code, email, phone, role
      `;
      queryParams = [user_id, name, emp_code, email, phone, role];
    }

    const result = await pool.query(queryText, queryParams);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json({
      message: passChange
        ? "User updated with new password"
        : "User updated successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating user:", error);
    if (error.code === "23505") {
      if (error.constraint === "users_email_key") {
        return res.status(400).json({ error: "Email address already exists." });
      }
      if (error.constraint === "users_emp_code_key") {
        return res.status(400).json({ error: "Employee code already exists." });
      }
      if (error.constraint === "users_phone_key") {
        return res.status(400).json({ error: "Phone number already exists." });
      }
      return res.status(400).json({ error: "Duplicate value violates unique credentials check." });
    }
    res.status(500).json({ error: "Updation failed" });
  }
});

// Helper function to check session limits
async function enforceSessionLimits(user) {
  const { user_id: userId, role, custom_login_policy, custom_max_devices } = user;
  if (role !== 'admin' && role !== 'supervisor') return null; 

  try {
    let mode = custom_login_policy;
    let maxDevices = custom_max_devices;

    if (!mode) {
      const settingsRes = await pool.query("SELECT * FROM security_settings WHERE id = 1");
      if (settingsRes.rows.length === 0) return null; 
      const settings = settingsRes.rows[0];

      mode = role === 'admin' ? settings.admin_login_mode : settings.supervisor_login_mode;
      maxDevices = role === 'admin' ? settings.admin_max_devices : settings.supervisor_max_devices;
    }

    const activeRes = await pool.query(
      "SELECT COUNT(*) FROM active_sessions WHERE user_id = $1 AND is_revoked = FALSE",
      [userId]
    );
    const activeCount = parseInt(activeRes.rows[0].count, 10);

    const isSingle = mode === 'single' || mode === 'strict_single';

    if (isSingle && activeCount >= 1) {
      return "Already logged in elsewhere. Please logout from the other device first.";
    }
    if (!isSingle && activeCount >= (maxDevices || 10)) {
      return "Maximum device limit reached. Please logout from an existing device.";
    }
  } catch (err) {
    console.error("Error enforcing session limits:", err);
  }
  return null;
}

// ✅ Login User (Web App - All Roles)
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (user.rows.length === 0)
      return res.status(400).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // ✅ Super admin bypass — SUPER_ADMIN_EMAIL can ALWAYS login
    const isSuperAdmin = user.rows[0].email === SUPER_ADMIN_EMAIL;

    // ✅ Block soft-deleted accounts (except super admin)
    if (!isSuperAdmin && user.rows[0].is_deleted === true) {
      return res.status(403).json({ error: "Your account has been deleted. Please contact the super admin." });
    }

    // ✅ Block inactive admin accounts (except super admin)
    if (!isSuperAdmin && user.rows[0].role === 'admin') {
      const perms = user.rows[0].permissions;
      if (perms && perms.is_active === false) {
        return res.status(403).json({ error: "Your account has been deactivated. Please contact the super admin." });
      }
    }

    // ✅ Enforce Strict Session Limits
    if (!isSuperAdmin) {
      const limitError = await enforceSessionLimits(user.rows[0]);
      if (limitError) {
        return res.status(403).json({ error: limitError });
      }
    }

    // ✅ 2FA Logic for Admin Role
    if (user.rows[0].role === 'admin') {
      const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit OTP
      const expiry = new Date(Date.now() + 5 * 60000); // 5 minutes
      
      await pool.query(
        "UPDATE users SET login_otp = $1, login_otp_expiry = $2 WHERE user_id = $3",
        [otp, expiry, user.rows[0].user_id]
      );

      const { sendOTPEmail } = require('../utils/emailService');
      console.log(`[2FA OTP GENERATED for ${user.rows[0].email}]: ${otp}`); // For easy testing
      await sendOTPEmail(user.rows[0].email, otp);

      return res.json({
        status: "pending_2fa",
        message: "OTP sent to your email. Please verify to login.",
        email: user.rows[0].email
      });
    }

    // Calculate seconds remaining until next midnight (12:00 AM) in Asia/Kolkata
    const getSecondsUntilMidnight = () => {
      const now = new Date();
      const kolkataTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
      const kolkataDate = new Date(kolkataTimeStr);
      
      const midnight = new Date(kolkataTimeStr);
      midnight.setHours(24, 0, 0, 0);
      
      const diffMs = midnight.getTime() - kolkataDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      return diffSec > 0 ? diffSec : 3600;
    };

    const secondsUntilMidnight = getSecondsUntilMidnight();

    // ✅ Generate JWT Token
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: secondsUntilMidnight }
    );

    // ✅ Record active session
    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || "unknown";
      const deviceInfo = req.headers["user-agent"] || "unknown";
      await pool.query(
        `INSERT INTO active_sessions (user_id, token_hash, ip_address, device, logged_in_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [user.rows[0].user_id, tokenHash, clientIp, deviceInfo]
      );
    } catch (sessionErr) {
      console.error("Warning: Failed to record session:", sessionErr.message);
    }

    const access = await getUserAccessProfile(user.rows[0].user_id);

    const primaryRole =
      access.roles?.[0]?.name || user.rows[0].role || "user";

    res.cookie("token", token, {
      httpOnly: true,
      maxAge: JWT_COOKIE_MAX_AGE_MS,
    });
    const allowedCities = await computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);
    const employeeProfile = await fetchEmployeeProfile(user.rows[0].emp_code);

    res.json({
      message: "Login successful",
      token,
      user: {
        user_id: user.rows[0].user_id,
        name: user.rows[0].name,
        email: user.rows[0].email,
        role: primaryRole,
        roles: access.roles,
        permissions: access.permissions,
        customPermissions: user.rows[0].permissions,
        emp_code: user.rows[0].emp_code,
        phone: user.rows[0].phone,
        allowedCities,
        uiPermissions,
        employee: employeeProfile,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Mobile App Login (Supervisors & Admins)
router.post("/supervisor-login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // Query for both supervisor and admin roles
    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1 AND (role = 'supervisor' OR role = 'admin')",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: "Access denied. Only supervisors and administrators can access the mobile app."
      });
    }

    const isMatch = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: "Invalid credentials"
      });
    }

    // ✅ Block soft-deleted accounts
    if (user.rows[0].is_deleted === true) {
      return res.status(403).json({ success: false, error: "Your account has been deleted. Please contact the super admin." });
    }

    // ✅ Block inactive admin accounts
    if (user.rows[0].role === 'admin') {
      const perms = user.rows[0].permissions;
      if (perms && perms.is_active === false) {
        return res.status(403).json({ success: false, error: "Your account has been deactivated. Please contact the super admin." });
      }
    }

    // ✅ Generate JWT Token for supervisor
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const access = await getUserAccessProfile(user.rows[0].user_id);

    const allowedCities = await computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);
    const employeeProfile = await fetchEmployeeProfile(user.rows[0].emp_code);

    res.json({
      success: true,
      message: "Supervisor login successful",
      token,
      user: {
        user_id: user.rows[0].user_id,
        name: user.rows[0].name,
        email: user.rows[0].email,
        role: access.roles?.[0]?.name || user.rows[0].role,
        roles: access.roles,
        permissions: access.permissions,
        customPermissions: user.rows[0].permissions,
        emp_code: user.rows[0].emp_code,
        phone: user.rows[0].phone,
        allowedCities,
        uiPermissions,
        employee: employeeProfile,
      },
    });
  } catch (error) {
    console.error("Supervisor login error:", error);
    res.status(500).json({
      success: false,
      error: "Login failed. Please try again."
    });
  }
});

// ✅ Verify OTP for Admin Login
router.post("/verify-login-otp", async (req, res) => {
  const { email, otp } = req.body;

  try {
    const user = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

    if (user.rows.length === 0)
      return res.status(400).json({ error: "Invalid request" });

    const userData = user.rows[0];

    if (!userData.login_otp || userData.login_otp !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (new Date(userData.login_otp_expiry) < new Date()) {
      return res.status(400).json({ error: "OTP has expired" });
    }

    // Clear OTP
    await pool.query(
      "UPDATE users SET login_otp = NULL, login_otp_expiry = NULL WHERE user_id = $1",
      [userData.user_id]
    );

    // ✅ Replicate token generation and session recording
    const getSecondsUntilMidnight = () => {
      const now = new Date();
      const kolkataTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
      const kolkataDate = new Date(kolkataTimeStr);
      const midnight = new Date(kolkataTimeStr);
      midnight.setHours(24, 0, 0, 0);
      const diffMs = midnight.getTime() - kolkataDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      return diffSec > 0 ? diffSec : 3600;
    };

    const token = jwt.sign(
      { user_id: userData.user_id, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: getSecondsUntilMidnight() }
    );

    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.connection?.remoteAddress || req.ip || "unknown";
      const deviceInfo = req.headers["user-agent"] || "unknown";
      await pool.query(
        `INSERT INTO active_sessions (user_id, token_hash, ip_address, device, logged_in_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userData.user_id, tokenHash, clientIp, deviceInfo]
      );
    } catch (sessionErr) {
      console.error("Warning: Failed to record session:", sessionErr.message);
    }

    const access = await getUserAccessProfile(userData.user_id);
    const primaryRole = access.roles?.[0]?.name || userData.role || "user";

    res.cookie("token", token, {
      httpOnly: true,
      maxAge: JWT_COOKIE_MAX_AGE_MS,
    });
    
    const allowedCities = await computeAllowedCities(userData, access);
    const uiPermissions = buildUiPermissions(access);
    const employeeProfile = await fetchEmployeeProfile(userData.emp_code);

    res.json({
      status: "success",
      message: "Login successful",
      token,
      user: {
        user_id: userData.user_id,
        name: userData.name,
        email: userData.email,
        role: primaryRole,
        roles: access.roles,
        permissions: access.permissions,
        customPermissions: userData.permissions,
        emp_code: userData.emp_code,
        phone: userData.phone,
        allowedCities,
        uiPermissions,
        employee: employeeProfile,
      },
    });

  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Logout User
router.post("/logout", async (req, res) => {
  // Revoke session in active_sessions table
  try {
    const bearer = req.header("Authorization") || "";
    const headerToken = bearer.startsWith("Bearer ") ? bearer.split(" ")[1] : null;
    const token = req.cookies?.token || headerToken;
    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await pool.query(
        `UPDATE active_sessions SET is_revoked = TRUE, revoked_at = NOW() WHERE token_hash = $1 AND is_revoked = FALSE`,
        [tokenHash]
      );
    }
  } catch (err) {
    console.error("Warning: Failed to revoke session on logout:", err.message);
  }
  res.clearCookie("token");
  res.json({ message: "Logged out successfully" });
});

// ✅ Create Admin User (One-time setup)
router.post("/create-admin", async (req, res) => {
  try {
    // Check if admin already exists
    const existingAdmin = await pool.query(
      "SELECT * FROM users WHERE role = 'admin' LIMIT 1"
    );

    if (existingAdmin.rows.length > 0) {
      return res.status(400).json({
        error: "Admin user already exists",
        admin: {
          name: existingAdmin.rows[0].name,
          email: existingAdmin.rows[0].email,
          emp_code: existingAdmin.rows[0].emp_code
        }
      });
    }

    // Create admin user
    const adminData = {
      name: "System Administrator",
      emp_code: "ADMIN001",
      email: "admin@attendease.com",
      phone: "9876543210",
      role: "admin",
      password: "admin123"
    };

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminData.password, salt);

    const result = await pool.query(
      `INSERT INTO users (name, emp_code, email, phone, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING user_id, name, email, emp_code, role`,
      [adminData.name, adminData.emp_code, adminData.email, adminData.phone, adminData.role, hashedPassword]
    );

    if (result.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        "SELECT user_id, name, email, emp_code, role FROM users WHERE email = $1 OR emp_code = $2 LIMIT 1",
        [adminData.email, adminData.emp_code]
      );
      return res.status(200).json({
        message: "Record exists, skipping",
        admin: existing.rows[0] || null,
        credentials: {
          email: adminData.email,
          password: adminData.password,
        },
      });
    }

    res.status(201).json({
      message: "Admin user created successfully",
      admin: result.rows[0],
      credentials: {
        email: adminData.email,
        password: adminData.password
      }
    });
  } catch (error) {
    console.error("Create admin error:", error);
    if (error.code === "23505") {
      console.warn("Record exists, skipping");
      return res.status(200).json({ message: "Record exists, skipping" });
    }
    res.status(500).json({ error: "Failed to create admin user" });
  }
});

module.exports = router;

// ==========================================
// SECURITY SETTINGS & SESSION LIMITS
// ==========================================

// ✅ GET Security Settings
router.get("/security-settings", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM security_settings WHERE id = 1");
    if (result.rows.length === 0) {
      return res.json({
        admin_login_mode: 'multiple', admin_max_devices: 10,
        supervisor_login_mode: 'multiple', supervisor_max_devices: 10
      });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch security settings" });
  }
});

// ✅ POST Security Settings (Admin only)
router.post("/security-settings", authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
  
  const { admin_login_mode, admin_max_devices, supervisor_login_mode, supervisor_max_devices } = req.body;
  try {
    await pool.query(
      `UPDATE security_settings 
       SET admin_login_mode = $1, admin_max_devices = $2, 
           supervisor_login_mode = $3, supervisor_max_devices = $4,
           updated_at = NOW()
       WHERE id = 1`,
      [admin_login_mode, admin_max_devices, supervisor_login_mode, supervisor_max_devices]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to update security settings" });
  }
});

// ✅ GET Active Sessions
router.get("/active-sessions", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.query; 
    let query = "SELECT id, ip_address, device, logged_in_at, last_active_at FROM active_sessions WHERE user_id = $1 AND is_revoked = FALSE ORDER BY logged_in_at DESC";
    let params = [req.user.user_id];
    
    if (req.user.role === 'admin' && userId) {
        params = [userId];
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch active sessions" });
  }
});

// ✅ POST Revoke Session
router.post("/revoke-session", authenticateToken, async (req, res) => {
  const { id } = req.body;
  try {
    if (req.user.role === 'admin') {
       await pool.query("UPDATE active_sessions SET is_revoked = TRUE, revoked_by = $1, revoked_at = NOW() WHERE id = $2", [req.user.user_id, id]);
    } else {
       await pool.query("UPDATE active_sessions SET is_revoked = TRUE, revoked_by = $1, revoked_at = NOW() WHERE id = $2 AND user_id = $3", [req.user.user_id, id, req.user.user_id]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to revoke session" });
  }
});
