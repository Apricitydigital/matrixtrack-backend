const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize, getPermissionCityFilter } = require("../middleware/permissionMiddleware");
const { attachCityScope, requireCityScope } = require("../middleware/cityScope");

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "mtadmin@apricitydigital.in";
const SUPER_ADMIN_DB_EMAIL = process.env.SUPER_ADMIN_DB_EMAIL || "admin@gmail.com";

// Middleware: only the super admin may call this endpoint
// NOTE: JWT token only carries user_id + role (no email), so we resolve email from DB.
const requireSuperAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(403).json({ error: "Super admin access required" });
    }

    const { rows } = await pool.query(
      "SELECT email FROM users WHERE user_id = $1 LIMIT 1",
      [userId]
    );
    if (!rows.length) {
      return res.status(403).json({ error: "Super admin access required" });
    }

    const email = (rows[0].email || "").trim().toLowerCase();
    if (
      email === SUPER_ADMIN_EMAIL.toLowerCase() ||
      email === SUPER_ADMIN_DB_EMAIL.toLowerCase()
    ) {
      req.user.email = email; // attach for downstream logging
      return next();
    }
    return res.status(403).json({ error: "Super admin access required" });
  } catch (err) {
    console.error("requireSuperAdmin error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
};

// 🟢 Get all cities with their active/inactive status (super admin only)
// IMPORTANT: this must be defined BEFORE the generic /:id routes
router.get(
  "/status",
  authenticate,
  requireSuperAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT city_id, city_name, state, COALESCE(is_active, true) AS is_active
           FROM public.cities
          ORDER BY city_name ASC`
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching city status:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

// 🟢 Toggle city active/inactive (super admin only)
router.patch(
  "/:id/toggle",
  authenticate,
  requireSuperAdmin,
  async (req, res) => {
    const { id } = req.params;
    try {
      const current = await pool.query(
        `SELECT city_id, city_name, COALESCE(is_active, true) AS is_active
           FROM public.cities WHERE city_id = $1`,
        [id]
      );
      if (current.rowCount === 0) {
        return res.status(404).json({ error: "City not found" });
      }

      const newStatus = !current.rows[0].is_active;
      const updated = await pool.query(
        `UPDATE public.cities
            SET is_active = $1
          WHERE city_id = $2
          RETURNING city_id, city_name, state, COALESCE(is_active, true) AS is_active`,
        [newStatus, id]
      );

      const action = newStatus ? "enabled" : "disabled";
      console.log(
        `[City Toggle] City "${updated.rows[0].city_name}" (id=${id}) ${action} by user ${req.user?.email}`
      );

      res.json({
        message: `City "${updated.rows[0].city_name}" has been ${action}.`,
        city: updated.rows[0],
      });
    } catch (error) {
      console.error("Error toggling city status:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

// 🟢 Fetch all cities
router.get("/", authenticate, attachCityScope, requireCityScope(true), async (req, res) => {
  try {
    const scope = req.cityScope || { all: false, ids: [] };
    const params = [];
    let whereClause = "";

    if (!scope.all) {
      params.push(scope.ids);
      whereClause = `WHERE city_id = ANY($${params.length})`;
    }

    const result = await pool.query(
      `SELECT city_id, city_name, state, COALESCE(is_active, true) AS is_active
         FROM public.cities ${whereClause} ORDER BY city_id ASC`,
      params
    );

    const permissionCities = getPermissionCityFilter(req, "city", "view");
    let rows = result.rows;
    if (Array.isArray(permissionCities) && permissionCities.length > 0) {
      const allowedSet = new Set(
        permissionCities.map((cityId) => Number(cityId))
      );
      rows = rows.filter((row) => allowedSet.has(Number(row.city_id)));
    }

    res.json(rows);
  } catch (error) {
    console.error("Error fetching cities:", error);
    res.status(500).json({ error: "Database error" });
  }
});

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
