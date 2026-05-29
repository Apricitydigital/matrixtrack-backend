const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/permissionMiddleware");
const { attachCityScope } = require("../middleware/cityScope");


// Get all designations
router.get(
  "/",
  authenticate,
  attachCityScope,
  async (req, res) => {
  try {
    const scope = req.cityScope || { all: true, ids: [] };
    const { city_id, department_id } = req.query;

    let query = `
      SELECT d.*, dept.department_name, COALESCE(ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL), ARRAY[]::INTEGER[]) as city_ids
      FROM designation d
      JOIN department dept ON d.department_id = dept.department_id
      LEFT JOIN designation_cities dc ON d.designation_id = dc.designation_id
    `;

    const params = [];
    let whereClauses = [];

    if (department_id) {
      params.push(department_id);
      whereClauses.push(`d.department_id = $${params.length}`);
    }

    if (city_id) {
      params.push(city_id);
      whereClauses.push(`EXISTS (SELECT 1 FROM designation_cities WHERE designation_id = d.designation_id AND city_id = $${params.length})`);
    }

    if (!scope.all) {
      if (scope.ids && scope.ids.length > 0) {
        params.push(scope.ids);
        whereClauses.push(`EXISTS (SELECT 1 FROM designation_cities WHERE designation_id = d.designation_id AND city_id = ANY($${params.length}))`);
      } else {
        whereClauses.push("1=0");
      }
    }

    if (whereClauses.length > 0) {
      query += " WHERE " + whereClauses.join(" AND ");
    }

    query += " GROUP BY d.designation_id, dept.department_name ORDER BY d.designation_id ASC";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching designations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
  }
);

// Insert a new designation
router.post(
  "/",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { designation_name, department_id, city_ids } = req.body;

  if (!designation_name || !department_id) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO designation (designation_name, department_id)
       VALUES ($1, $2)
       ON CONFLICT (designation_name, department_id) DO NOTHING
       RETURNING *`,
      [designation_name, department_id]
    );

    let designation;
    if (result.rowCount === 0) {
      const existing = await client.query(
        `SELECT * FROM designation WHERE designation_name = $1 AND department_id = $2 LIMIT 1`,
        [designation_name, department_id]
      );
      designation = existing.rows[0];
    } else {
      designation = result.rows[0];
    }

    // Link cities
    if (Array.isArray(city_ids) && city_ids.length > 0) {
      await client.query("DELETE FROM designation_cities WHERE designation_id = $1", [designation.designation_id]);
      const values = city_ids.map((cid, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO designation_cities (designation_id, city_id) VALUES ${values}`,
        [designation.designation_id, ...city_ids]
      );
    }

    await client.query("COMMIT");

    // Fetch full record to include department_name
    const fullRecord = await pool.query(
      `SELECT d.*, dept.department_name, COALESCE(ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL), ARRAY[]::INTEGER[]) as city_ids
       FROM designation d
       JOIN department dept ON d.department_id = dept.department_id
       LEFT JOIN designation_cities dc ON d.designation_id = dc.designation_id
       WHERE d.designation_id = $1
       GROUP BY d.designation_id, dept.department_name`,
      [designation.designation_id]
    );

    res.status(201).json(fullRecord.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error adding designation:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
  }
);

// Update an existing designation
router.put(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { designation_name, department_id, city_ids } = req.body;
  const designationId = req.params.id;

  if (!designation_name || !department_id) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      "UPDATE designation SET designation_name = $1, department_id = $2 WHERE designation_id = $3 RETURNING *",
      [designation_name, department_id, designationId]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Designation not found" });
    }

    // Update city links
    await client.query("DELETE FROM designation_cities WHERE designation_id = $1", [designationId]);
    if (Array.isArray(city_ids) && city_ids.length > 0) {
      const values = city_ids.map((cid, i) => `($1, $${i + 2})`).join(",");
      await client.query(
        `INSERT INTO designation_cities (designation_id, city_id) VALUES ${values}`,
        [designationId, ...city_ids]
      );
    }

    await client.query("COMMIT");

    // Fetch full record to include department_name
    const fullRecord = await pool.query(
      `SELECT d.*, dept.department_name, COALESCE(ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL), ARRAY[]::INTEGER[]) as city_ids
       FROM designation d
       JOIN department dept ON d.department_id = dept.department_id
       LEFT JOIN designation_cities dc ON d.designation_id = dc.designation_id
       WHERE d.designation_id = $1
       GROUP BY d.designation_id, dept.department_name`,
      [designationId]
    );

    res.json(fullRecord.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating designation:", error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
  }
);

// Delete a designation
router.delete(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
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
  }
);

module.exports = router;
