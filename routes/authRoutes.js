const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware"); // ✅ Import middleware

const router = express.Router();

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

const computeAllowedCities = (userRow, access) => {
  const isAdminRole =
    (userRow?.role || "").toLowerCase() === "admin" ||
    access?.roles?.some(
      (role) => (role.name || "").toLowerCase() === "admin"
    );
  if (isAdminRole) {
    return null; // all cities
  }

  const scope =
    access.permissions
      ?.filter(
        (perm) =>
          perm.module?.toLowerCase() === "city" &&
          perm.action?.toLowerCase() === "view"
      )
      .reduce(
        (acc, perm) => {
          if (perm.city_id === null || perm.city_id === undefined) {
            acc.all = true;
          } else {
            acc.ids.add(Number(perm.city_id));
          }
          return acc;
        },
        { all: false, ids: new Set() }
      ) || { all: false, ids: new Set() };

  if (scope.all) return null;
  const list = Array.from(scope.ids.values()).filter((id) =>
    Number.isFinite(id)
  );
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

    const access = await getUserAccessProfile(req.user.user_id);

    const allowedCities = computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);

    res.json({
      ...user.rows[0],
      access,
      allowedCities,
      uiPermissions,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

    // ✅ Generate JWT Token
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    const access = await getUserAccessProfile(user.rows[0].user_id);

    const primaryRole =
      access.roles?.[0]?.name || user.rows[0].role || "user";

    res.cookie("token", token, { httpOnly: true });
    const allowedCities = computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);

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
        emp_code: user.rows[0].emp_code,
        phone: user.rows[0].phone,
        allowedCities,
        uiPermissions,
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

    // ✅ Generate JWT Token for supervisor
    const token = jwt.sign(
      { user_id: user.rows[0].user_id, role: user.rows[0].role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    const access = await getUserAccessProfile(user.rows[0].user_id);

    const allowedCities = computeAllowedCities(user.rows[0], access);
    const uiPermissions = buildUiPermissions(access);

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
        emp_code: user.rows[0].emp_code,
        phone: user.rows[0].phone,
        allowedCities,
        uiPermissions,
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
