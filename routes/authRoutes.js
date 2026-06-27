const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
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
      const empCodeCheckUsers = await pool.query("SELECT user_id FROM users WHERE emp_code = $1 LIMIT 1", [emp_code.trim()]);
      const empCodeCheckEmployees = await pool.query("SELECT emp_id FROM employee WHERE emp_code = $1 LIMIT 1", [emp_code.trim()]);
      empCodeExists = empCodeCheckUsers.rowCount > 0 || empCodeCheckEmployees.rowCount > 0;
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
       RETURNING user_id, name, role`,
      [name, emp_code, email, phone, role, hashedPassword]
    );

    res.status(201).json({ message: "User registered", user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      if (error.constraint === "users_email_key") {
        return res.status(400).json({ error: "Email address already registered." });
      }
      if (error.constraint === "users_emp_code_key") {
        return res.status(400).json({ error: "Employee code already exists." });
      }
      if (error.constraint === "users_phone_key") {
        return res.status(400).json({ error: "Phone number already registered." });
      }
      return res.status(400).json({ error: "Duplicate value violates unique credentials check." });
    }
    console.error("Registration failed error:", error);
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

    // ✅ Super admin bypass — admin@gmail.com can ALWAYS login
    const isSuperAdmin = user.rows[0].email === 'admin@gmail.com';

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

    // ✅ Generate JWT Token
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

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
