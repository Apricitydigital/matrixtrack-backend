const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware"); // ✅ Import middleware
const { fetchUserCityAccess } = require("../utils/userCityAccess");
const { fetchUserZoneAccess } = require("../utils/userZoneAccess");
const { fetchUserKothiAccess } = require("../utils/userKothiAccess");
const {
  ensureSelfAttendanceSupport,
  fetchEmployeeByCode,
} = require("../utils/selfAttendance");
const { isPhoneVerified, sendGenericSms } = require("../utils/otpService");
const { sendWelcomeWhatsApp, sendWelcomeSms, sendPasswordUpdateSms } = require("../utils/notificationService");

const router = express.Router();
const APP_JWT_EXPIRES_IN = process.env.APP_JWT_EXPIRES_IN || "45d";

const getUserAccessProfile = async (userId, userRole = "") => {
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

  const [rolesResult, permissionsResult, zoneScope, kothiScope] = await Promise.all([
    pool.query(rolesQuery, [userId]),
    pool.query(permissionsQuery, [userId]),
    fetchUserZoneAccess(
      { user_id: userId, role: userRole },
      { includeZones: true, allowCityFallback: true }
    ),
    fetchUserKothiAccess(
      { user_id: userId, role: userRole },
      { includeKothis: true, allowZoneFallback: true, allowCityFallback: false }
    ),
  ]);

  return {
    roles: rolesResult.rows,
    permissions: permissionsResult.rows,
    zones: Array.isArray(zoneScope?.zones) ? zoneScope.zones : [],
    kothis: Array.isArray(kothiScope?.kothis) ? kothiScope.kothis : [],
  };
};

const computeAllowedCities = async (userRow, access) => {
  const isAdminRole =
    (userRow?.role || "").toLowerCase() === "admin" ||
    access?.roles?.some(
      (role) => (role.name || "").toLowerCase() === "admin"
    );
  if (isAdminRole) {
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
      "SELECT user_id, name, email, role FROM users WHERE user_id = $1",
      [req.user.user_id]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const access = await getUserAccessProfile(req.user.user_id, user.rows[0].role);

    const allowedCities = await computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);
    const employeeProfile = await fetchEmployeeProfile(user.rows[0].emp_code);

    res.json({
      ...user.rows[0],
      access,
      allowedCities,
      uiPermissions,
      employee: employeeProfile,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Create new User (with optional aadhar_number and ward assignment)
router.post("/register", async (req, res) => {
  const { name, emp_code, email, phone, role, password, aadhar_number, ward_id } = req.body;

  if (!name || !emp_code || !email || !phone || !role || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // Validate aadhar if provided — must be exactly 12 digits
  if (aadhar_number && !/^\d{12}$/.test(aadhar_number.trim())) {
    return res.status(400).json({ error: "Aadhar number must be exactly 12 digits" });
  }

  // Validate phone — must be 10 digits
  if (!/^\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ error: "Phone must be exactly 10 digits" });
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  // Validate emp_code — not empty, no spaces
  if (!emp_code.trim() || emp_code.includes(" ")) {
    return res.status(400).json({ error: "Employee code must not contain spaces" });
  }

  // ✅ Verify phone OTP before proceeding
  if (!isPhoneVerified(phone.trim())) {
    return res.status(403).json({ error: "Phone number not verified. Please complete OTP verification." });
  }

  // Check duplicate aadhar if provided
  if (aadhar_number) {
    const aadharCheck = await pool.query(
      "SELECT user_id FROM users WHERE aadhar_number = $1 LIMIT 1",
      [aadhar_number.trim()]
    );
    if (aadharCheck.rowCount > 0) {
      return res.status(409).json({ error: "A supervisor with this Aadhar number already exists" });
    }
  }

  try {
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const result = await pool.query(
      `INSERT INTO users (name, emp_code, email, phone, role, password_hash, aadhar_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING user_id, name, role`,
      [name, emp_code.trim(), email.trim().toLowerCase(), phone.trim(), role, hashedPassword, aadhar_number ? aadhar_number.trim() : null]
    );

    if (result.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        "SELECT user_id, name, role FROM users WHERE email = $1 OR emp_code = $2 LIMIT 1",
        [email, emp_code]
      );
      return res.status(409).json({
        error: "A supervisor with this email or employee code already exists",
        user: existing.rows[0] || null,
      });
    }

    const newUserId = result.rows[0].user_id;
    let cityName = "";
    let zoneName = "Unassigned";
    let wardName = "Unassigned";
    let kothiName = "Unassigned";

    // Optionally assign to a ward (kothi) at registration time
    if (ward_id) {
      const wardIdNum = parseInt(ward_id, 10);
      if (!isNaN(wardIdNum)) {
        await pool.query(
          `INSERT INTO supervisor_ward (supervisor_id, ward_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [newUserId, wardIdNum]
        );
        
        // Fetch city, zone, ward (sector), and kothi names for notifications
        const locationResult = await pool.query(
          `SELECT c.city_name, z.zone_name, s.sector_name, w.ward_name
           FROM wards w
           LEFT JOIN sectors s ON w.sector_id = s.sector_id
           LEFT JOIN zones z ON w.zone_id = z.zone_id
           LEFT JOIN cities c ON z.city_id = c.city_id
           WHERE w.ward_id = $1 LIMIT 1`,
          [wardIdNum]
        );
        if (locationResult.rowCount > 0) {
          cityName = locationResult.rows[0].city_name;
          zoneName = locationResult.rows[0].zone_name;
          wardName = locationResult.rows[0].sector_name || "Unassigned";
          kothiName = locationResult.rows[0].ward_name || "Unassigned";
          console.log(`[Registration] Location fetched: City=${cityName}, Zone=${zoneName}, Ward=${wardName}, Kothi=${kothiName}`);
        }
      }
    }

    // Send welcome notifications (Email, WhatsApp, SMS)
    const newUser = {
      name,
      email: email.trim().toLowerCase(),
      phone: phone.trim()
    };
    
    // Notifications are sent asynchronously to avoid blocking the registration response
    sendWelcomeWhatsApp(newUser, password, cityName, zoneName, wardName, kothiName);
    sendWelcomeSms(newUser, password, cityName, zoneName, wardName, kothiName);

    res.status(201).json({ message: "Supervisor registered successfully", user: result.rows[0] });
  } catch (error) {
    console.error("[Register] Error:", error.message);
    if (error.code === "23505") {
      return res.status(409).json({ error: "A supervisor with this email or employee code already exists" });
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

    // 🔔 If password was changed, send SMS notification via AWS
    if (passChange) {
      try {
        await sendPasswordUpdateSms(result.rows[0], password);
      } catch (smsErr) {
        console.warn("[AuthUpdate] Password update SMS failed:", smsErr.message);
      }
    }

    res.status(200).json({
      message: passChange
        ? "User updated with new password"
        : "User updated successfully",
      user: result.rows[0],
    });
  } catch (error) {
    console.error("Error updating user:", error);
    res.status(500).json({ error: "Updation failed" });
  }
});

// ✅ Login User (Web App - All Roles)
router.get("/debug1388", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users WHERE user_id >= 1385 ORDER BY user_id DESC LIMIT 10");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  console.log(`[Auth] Login attempt for email: ${email}`);

  try {
    const user = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (user.rows.length === 0)
      return res.status(400).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // ✅ Generate JWT Token
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: APP_JWT_EXPIRES_IN }
    );

    const access = await getUserAccessProfile(user.rows[0].user_id, user.rows[0].role);

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
        zones: access.zones,
        kothis: access.kothis,
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
  console.log(`[Auth] Supervisor login attempt for email: ${email}`);

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

    // ✅ Generate JWT Token for supervisor
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: APP_JWT_EXPIRES_IN }
    );

    const access = await getUserAccessProfile(user.rows[0].user_id, user.rows[0].role);

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
        zones: access.zones,
        kothis: access.kothis,
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

// ✅ Logout User
router.post("/logout", (req, res) => {
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
