const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/permissionMiddleware");
const { attachCityScope } = require("../middleware/cityScope");


// Get all departments
router.get(
  "/",
  authenticate,
  attachCityScope,
  async (req, res) => {
  try {
    const scope = req.cityScope || { all: true, ids: [] };
    const { city_id } = req.query;
    
    let query = `
      SELECT d.*, COALESCE(ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL), ARRAY[]::INTEGER[]) as city_ids
      FROM department d
      LEFT JOIN department_cities dc ON d.department_id = dc.department_id
    `;
    
    const params = [];
    let whereClauses = [];

    // Filter by city_id from query param if provided
    if (city_id) {
      params.push(city_id);
      whereClauses.push(`EXISTS (SELECT 1 FROM department_cities WHERE department_id = d.department_id AND city_id = $${params.length})`);
    }

    // Apply city scope filtering if not an admin with 'all' scope
    if (!scope.all) {
      if (scope.ids && scope.ids.length > 0) {
        params.push(scope.ids);
        whereClauses.push(`EXISTS (SELECT 1 FROM department_cities WHERE department_id = d.department_id AND city_id = ANY($${params.length}))`);
      } else {
        // If scope restricted but no IDs assigned, return nothing
        whereClauses.push("1=0");
      }
    }

    if (whereClauses.length > 0) {
      query += " WHERE " + whereClauses.join(" AND ");
    }

    query += " GROUP BY d.department_id ORDER BY d.department_id ASC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching departments:", err);
    res.status(500).json({ error: "Internal server error" });
  }
  }
);

// Add a new department
router.post(
  "/",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { department_name, city_ids } = req.body;

  if (!department_name) {
    return res.status(400).json({ error: "Department name is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO department (department_name)
       VALUES ($1)
       ON CONFLICT (department_name) DO NOTHING
       RETURNING *`,
      [department_name]
    );

    let department;
    if (result.rowCount === 0) {
      const existing = await client.query(
        "SELECT * FROM department WHERE department_name = $1 LIMIT 1",
        [department_name]
      );
      department = existing.rows[0];
    } else {
      department = result.rows[0];
    }

    // Link cities
    if (Array.isArray(city_ids) && city_ids.length > 0) {
      // Clear existing if any (in case of ON CONFLICT resolution)
      await client.query("DELETE FROM department_cities WHERE department_id = $1", [department.department_id]);
      
      const values = city_ids.map((cid, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO department_cities (department_id, city_id) VALUES ${values}`,
        [department.department_id, ...city_ids]
      );
    }

    await client.query("COMMIT");

    // Fetch full record to include aggregated city_ids
    const fullRecord = await pool.query(
      `SELECT d.*, COALESCE(ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL), ARRAY[]::INTEGER[]) as city_ids
       FROM department d
       LEFT JOIN department_cities dc ON d.department_id = dc.department_id
       WHERE d.department_id = $1
       GROUP BY d.department_id`,
      [department.department_id]
    );

    res.status(201).json(fullRecord.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error adding department:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
  }
);

// Update a department
router.put(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { id } = req.params;
  const { department_name, city_ids } = req.body;

  if (!department_name) {
    return res.status(400).json({ error: "Department name is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      "UPDATE department SET department_name = $1 WHERE department_id = $2 RETURNING *",
      [department_name, id]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Department not found" });
    }

    // Update city links
    await client.query("DELETE FROM department_cities WHERE department_id = $1", [id]);
    if (Array.isArray(city_ids) && city_ids.length > 0) {
      const values = city_ids.map((cid, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO department_cities (department_id, city_id) VALUES ${values}`,
        [id, ...city_ids]
      );
    }

    await client.query("COMMIT");

    // Fetch full record to include aggregated city_ids
    const fullRecord = await pool.query(
      `SELECT d.*, COALESCE(ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL), ARRAY[]::INTEGER[]) as city_ids
       FROM department d
       LEFT JOIN department_cities dc ON d.department_id = dc.department_id
       WHERE d.department_id = $1
       GROUP BY d.department_id`,
      [id]
    );

    res.json(fullRecord.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating department:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
  }
);

// Delete a department
router.delete(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
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
  }
);

module.exports = router;
