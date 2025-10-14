const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Get all departments
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM department ORDER BY department_id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching departments:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add a new department
router.post("/", async (req, res) => {
  const { department_name } = req.body;

  if (!department_name) {
    return res.status(400).json({ error: "Department name is required" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO department (department_name) VALUES ($1) RETURNING *",
      [department_name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error adding department:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update a department
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { department_name } = req.body;

  if (!department_name) {
    return res.status(400).json({ error: "Department name is required" });
  }

  try {
    const result = await pool.query(
      "UPDATE department SET department_name = $1 WHERE department_id = $2 RETURNING *",
      [department_name, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Department not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating department:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a department
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM department WHERE department_id = $1",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Department not found" });
    }

    res.json({ message: "Department deleted successfully" });
  } catch (err) {
    console.error("Error deleting department:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
