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

module.exports = router;
