const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Get all designations
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.designation_id, d.designation_name, d.department_id, 
              dept.department_name 
       FROM designation d 
       JOIN department dept ON d.department_id = dept.department_id`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching designations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Insert a new designation
router.post("/", async (req, res) => {
  const { designation_name, department_id } = req.body;

  if (!designation_name || !department_id) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO designation (designation_name, department_id) VALUES ($1, $2) RETURNING *",
      [designation_name, department_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error adding designation:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update an existing designation
router.put("/:id", async (req, res) => {
  const { designation_name, department_id } = req.body;
  const designationId = req.params.id;

  if (!designation_name || !department_id) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const result = await pool.query(
      "UPDATE designation SET designation_name = $1, department_id = $2 WHERE designation_id = $3 RETURNING *",
      [designation_name, department_id, designationId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Designation not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating designation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a designation
router.delete("/:id", async (req, res) => {
  try {
    const designationId = req.params.id;

    const result = await pool.query(
      "DELETE FROM designation WHERE designation_id = $1 RETURNING *",
      [designationId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Designation not found" });
    }

    res.json({ message: "Designation deleted successfully" });
  } catch (error) {
    console.error("Error deleting designation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
