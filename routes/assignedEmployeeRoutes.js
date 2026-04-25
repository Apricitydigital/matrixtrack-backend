const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");

// List assignments (optionally filter by supervisor_id or employee_id)
router.get("/", authenticate, async (req, res) => {
  try {
    const { supervisor_id, employee_id } = req.query;
    const params = [];
    const where = [];

    if (supervisor_id) {
      params.push(Number(supervisor_id));
      where.push(`sea.supervisor_id = $${params.length}`);
    }
    if (employee_id) {
      params.push(Number(employee_id));
      where.push(`sea.employee_id = $${params.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT
         sea.assignment_id,
         sea.supervisor_id,
         sea.employee_id,
         sea.is_active,
         sea.assigned_at,
         u.name       AS supervisor_name,
         u.emp_code   AS supervisor_code,
         e.name       AS employee_name,
         e.emp_code   AS employee_code,
         e.ward_id    AS employee_ward_id
       FROM supervisor_employee_assignment sea
       JOIN users u    ON u.user_id = sea.supervisor_id
       JOIN employee e ON e.emp_id = sea.employee_id
       ${whereClause}
       ORDER BY sea.assignment_id DESC`,
      params
    );

    res.json(rows);
  } catch (error) {
    console.error("Error fetching supervisor-employee assignments:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Create assignment (idempotent on supervisor + employee)
router.post("/", authenticate, async (req, res) => {
  try {
    const supervisorId = Number(req.body.supervisor_id || req.body.user_id);
    const employeeId = Number(req.body.employee_id || req.body.emp_id);
    if (!supervisorId || !employeeId) {
      return res.status(400).json({ error: "supervisor_id and employee_id are required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO supervisor_employee_assignment (supervisor_id, employee_id)
       VALUES ($1, $2)
       ON CONFLICT (supervisor_id, employee_id)
       DO UPDATE SET is_active = TRUE, assigned_at = NOW()
       RETURNING *`,
      [supervisorId, employeeId]
    );

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error("Error creating supervisor-employee assignment:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Update (activate/deactivate or move employee)
router.put("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const supervisorId = req.body.supervisor_id ? Number(req.body.supervisor_id) : null;
    const employeeId = req.body.employee_id ? Number(req.body.employee_id) : null;
    const isActive =
      req.body.is_active === undefined || req.body.is_active === null
        ? null
        : Boolean(req.body.is_active);

    if (!id) return res.status(400).json({ error: "assignment id required" });

    const sets = [];
    const params = [];
    if (supervisorId) {
      params.push(supervisorId);
      sets.push(`supervisor_id = $${params.length}`);
    }
    if (employeeId) {
      params.push(employeeId);
      sets.push(`employee_id = $${params.length}`);
    }
    if (isActive !== null) {
      params.push(isActive);
      sets.push(`is_active = $${params.length}`);
    }
    params.push(id);

    if (sets.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const { rowCount, rows } = await pool.query(
      `UPDATE supervisor_employee_assignment
       SET ${sets.join(", ")}, assigned_at = NOW()
       WHERE assignment_id = $${params.length}
       RETURNING *`,
      params
    );

    if (rowCount === 0) return res.status(404).json({ error: "Assignment not found" });
    res.json(rows[0]);
  } catch (error) {
    console.error("Error updating supervisor-employee assignment:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Delete assignment
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "assignment id required" });

    const { rowCount } = await pool.query(
      "DELETE FROM supervisor_employee_assignment WHERE assignment_id = $1",
      [id]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Assignment not found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting supervisor-employee assignment:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
