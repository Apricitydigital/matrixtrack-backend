const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const {
  authorize,
  getPermissionCityFilter,
} = require("../middleware/permissionMiddleware");

// 🟢 Fetch all cities
router.get(
  "/",
  authenticate,
  async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM public.cities ORDER BY city_id ASC"
    );
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
    console.error("Error fetching cities:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Add a new city
router.post(
  "/",
  authenticate,
  authorize("city", "manage"),
  async (req, res) => {
  const { city_name, state } = req.body;
  if (!city_name || !state) {
    return res.status(400).json({ error: "City name and state are required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO public.cities (city_name, state)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [city_name, state]
    );

    if (result.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        `SELECT * FROM public.cities WHERE city_name = $1 AND state = $2 LIMIT 1`,
        [city_name, state]
      );
      return res
        .status(200)
        .json(existing.rows[0] || { message: "Record exists, skipping" });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error adding city:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Update a city
router.put(
  "/:id",
  authenticate,
  authorize("city", "manage"),
  async (req, res) => {
  const { id } = req.params;
  const { city_name, state } = req.body;
  if (!city_name || !state) {
    return res.status(400).json({ error: "City name and state are required" });
  }
  try {
    const result = await pool.query(
      "UPDATE public.cities SET city_name = $1, state = $2 WHERE city_id = $3 RETURNING *",
      [city_name, state, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "City not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating city:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Delete a city
router.delete(
  "/:id",
  authenticate,
  authorize("city", "manage"),
  async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM public.cities WHERE city_id = $1",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "City not found" });
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting city:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

module.exports = router;
