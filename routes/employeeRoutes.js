const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { buildPublicFaceUrl } = require("../utils/faceImage");
const { isBackblazeUrl } = require("../utils/backblaze");
const authenticate = require("../middleware/authMiddleware");
const { attachCityScope, requireCityScope, buildCityFilterClause } = require("../middleware/cityScope");
const { attachKothiScope, buildKothiFilterClause } = require("../middleware/kothiScope");

const resolveFaceImageUrl = (faceEmbedding, empId) => {
  if (!faceEmbedding) {
    return null;
  }

  const publicUrl = buildPublicFaceUrl(faceEmbedding);
  if (publicUrl) {
    return publicUrl;
  }

  if (isBackblazeUrl(faceEmbedding) && empId !== undefined && empId !== null) {
    return `app/attendance/employee/faceRoutes/image/${empId}`;
  }

  if (typeof faceEmbedding === "string") {
    return faceEmbedding;
  }

  return null;
};

const formatEmployeeRow = (row = {}) => {
  const faceImageUrl = resolveFaceImageUrl(row.face_embedding, row.emp_id);
  const faceRegistered = Boolean(row.face_embedding);

  return {
    ...row,
    face_registered: faceRegistered,
    faceRegistered,
    face_image_url: faceImageUrl,
    faceImageUrl,
  };
};

const parseId = (id) => {
  if (id === undefined || id === null) return null;
  if (typeof id === "string" && id.trim() === "") return null;
  const parsed = parseInt(id, 10);
  return isNaN(parsed) ? null : parsed;
};

// 🟢 Fetch all employees with city, zone, ward, department, and designation
router.get(
  "/",
  authenticate,
  attachKothiScope,
  attachCityScope,
  requireCityScope(),
  async (req, res) => {
    try {
      const scope = req.cityScope || { all: false, ids: [] };
      const kothiScope = req.kothiScope || { all: true, ids: [] };
      
      const cityFilter = buildCityFilterClause(scope, "c", []);
      const kothiFilter = buildKothiFilterClause(kothiScope, "w", cityFilter.params);

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
        ds.designation_name AS designation,
        e.face_embedding
      FROM employee e
      LEFT JOIN wards w ON e.ward_id = w.ward_id
      LEFT JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN designation ds ON e.designation_id = ds.designation_id
      LEFT JOIN department d ON ds.department_id = d.department_id
      ${cityFilter.clause} ${kothiFilter.clause};`,
        kothiFilter.params
      );
    res.json(result.rows.map(formatEmployeeRow));
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// 🟢 Insert or update an employee
router.post("/", async (req, res) => {
  const { name, emp_code, phone, ward_id, designation_id } = req.body;

  if (!emp_code) {
    return res.status(400).json({ error: "emp_code is required" });
  }

  const insertEmployeeQuery = `
    INSERT INTO employee (emp_code, name, phone, ward_id, designation_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;

  try {
    const result = await pool.query(insertEmployeeQuery, [
      emp_code,
      name,
      phone,
      parseId(ward_id),
      parseId(designation_id),
    ]);
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        message: "This employee assignment already exists (same code and kothi).",
        emp_code,
      });
    }
    console.error("Error inserting employee:", error);
    return res.status(500).json({ message: "Internal error" });
  }
});

// 🟢 Update an existing employee and return updated details
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    let { name, emp_code, phone, ward_id, designation_id, updateAllWithCode } = req.body;

    // Normalize inputs
    name = (name || "").trim();
    emp_code = (emp_code || "").trim();

    await client.query('BEGIN');

    // 1. Fetch current details to get the original emp_code
    const currentRes = await client.query('SELECT emp_code FROM employee WHERE emp_id = $1', [id]);
    if (currentRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Employee not found" });
    }
    const originalCode = (currentRes.rows[0].emp_code || "").trim();

    let result;
    if (updateAllWithCode && originalCode) {
      // Update Name, Phone, and Designation for ALL records with the ORIGINAL code
      // We also update their emp_code in case it was changed in the form
      result = await client.query(
        `UPDATE employee 
         SET name = $1, phone = $2, designation_id = $3, emp_code = $4
         WHERE TRIM(emp_code) = TRIM($5) OR TRIM(emp_code) = TRIM($4)
         RETURNING *`,
        [name, phone, parseId(designation_id), emp_code, originalCode]
      );
      
      // Update the specific record's ward_id (location is record-specific)
      await client.query(
        `UPDATE employee 
         SET ward_id = $1 
         WHERE emp_id = $2`,
        [parseId(ward_id), id]
      );
    } else {
      result = await client.query(
        `UPDATE employee 
         SET name = $1, emp_code = $2, phone = $3, ward_id = $4, designation_id = $5 
         WHERE emp_id = $6 
         RETURNING *`,
        [name, emp_code, phone, parseId(ward_id), parseId(designation_id), id]
      );
    }

    await client.query('COMMIT');

    // Fetch the updated details for the specific ID to return it
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
          ds.designation_name AS designation,
          e.face_embedding
       FROM employee e
       LEFT JOIN wards w ON e.ward_id = w.ward_id
       LEFT JOIN zones z ON w.zone_id = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       LEFT JOIN designation ds ON e.designation_id = ds.designation_id
       LEFT JOIN department d ON ds.department_id = d.department_id
       WHERE e.emp_id = $1;`,
      [id]
    );

    res.json(formatEmployeeRow(updatedEmployee.rows[0]));
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error("Error updating employee:", error);
    if (error.code === "23505") {
      return res.status(409).json({
        error: `Employee with emp_code ${req.body.emp_code} already exists`,
      });
    }
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
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
