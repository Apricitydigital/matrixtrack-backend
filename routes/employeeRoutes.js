const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// 🟢 Fetch all employees with city, zone, ward, department, and designation
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        e.emp_id, 
        e.name, 
        e.emp_code, 
        e.phone, 
        c.city_name AS city, 
        z.zone_name AS zone, 
        w.ward_name AS ward, 
        d.department_name AS department, 
        ds.designation_name AS designation
      FROM employee e
      LEFT JOIN wards w ON e.ward_id = w.ward_id
      LEFT JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN designation ds ON e.designation_id = ds.designation_id
      LEFT JOIN department d ON ds.department_id = d.department_id;`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Insert a new employee
router.post("/", async (req, res) => {
  try {
    const { name, emp_code, phone, ward_id, designation_id } = req.body;
    const result = await pool.query(
      `INSERT INTO employee (name, emp_code, phone, ward_id, designation_id) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, emp_code, phone, ward_id, designation_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error inserting employee:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Update an existing employee and return updated details
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, emp_code, phone, ward_id, designation_id } = req.body;
    const result = await pool.query(
      `UPDATE employee 
       SET name = $1, emp_code = $2, phone = $3, ward_id = $4, designation_id = $5 
       WHERE emp_id = $6 
       RETURNING *`,
      [name, emp_code, phone, ward_id, designation_id, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // Fetch the updated details
    const updatedEmployee = await pool.query(
      `SELECT 
          e.emp_id, 
          e.name, 
          e.emp_code, 
          e.phone, 
          c.city_name AS city, 
          z.zone_name AS zone, 
          w.ward_name AS ward, 
          d.department_name AS department, 
          ds.designation_name AS designation
       FROM employee e
       LEFT JOIN wards w ON e.ward_id = w.ward_id
       LEFT JOIN zones z ON w.zone_id = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       LEFT JOIN designation ds ON e.designation_id = ds.designation_id
       LEFT JOIN department d ON ds.department_id = d.department_id
       WHERE e.emp_id = $1;`,
      [id]
    );

    res.json(updatedEmployee.rows[0]);
  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Delete an employee
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM employee WHERE emp_id = $1", [
      id,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }

    res.json({ message: "Employee deleted successfully" });
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
