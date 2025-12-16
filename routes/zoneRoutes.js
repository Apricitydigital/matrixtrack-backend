const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize, getPermissionCityFilter } = require("../middleware/permissionMiddleware");

// 🟢 Fetch all zones with city names
router.get(
  "/",
  authenticate,
  async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT z.zone_id, z.zone_name, c.city_id, c.city_name
      FROM zones z
      JOIN cities c ON z.city_id = c.city_id
      ORDER BY z.zone_id ASC
    `);
    const allowedCities = getPermissionCityFilter(req, "city", "view");
    let rows = result.rows;
    if (Array.isArray(allowedCities) && allowedCities.length > 0) {
      const allowedSet = new Set(
        allowedCities.map((cityId) => Number(cityId))
      );
      rows = rows.filter((row) => allowedSet.has(Number(row.city_id)));
    }
    res.json(rows);
  } catch (error) {
    console.error("Error fetching zones:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Add a new zone
router.post(
  "/",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { zone_name, city_id } = req.body;
  if (!zone_name || !city_id) {
    return res
      .status(400)
      .json({ error: "Zone name and city ID are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO zones (zone_name, city_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [zone_name, city_id]
    );

    if (result.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        `SELECT * FROM zones WHERE zone_name = $1 AND city_id = $2 LIMIT 1`,
        [zone_name, city_id]
      );
      return res
        .status(200)
        .json(existing.rows[0] || { message: "Record exists, skipping" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error adding zone:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Edit a zone
router.put(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { id } = req.params;
  const { zone_name } = req.body;

  try {
    const result = await pool.query(
      `UPDATE zones SET zone_name = $1 WHERE zone_id = $2 RETURNING *`,
      [zone_name, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating zone:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Delete a zone
router.delete(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM zones WHERE zone_id = $1 RETURNING *`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }
    res.json({ message: "Zone deleted successfully" });
  } catch (error) {
    console.error("Error deleting zone:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

module.exports = router;
