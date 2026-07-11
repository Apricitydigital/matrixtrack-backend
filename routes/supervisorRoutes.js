const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware"); // Ensure users are logged in
const {
  authorize,
} = require("../middleware/permissionMiddleware");
const { attachCityScope, requireCityScope } = require("../middleware/cityScope");

const enforceCityScope = (req, requestedCityId) => {
  const scope = req.cityScope || { all: false, ids: [] };
  if (scope.all) {
    return { cityId: requestedCityId ?? null, allowed: true };
  }

  const allowedCityIds = (scope.ids || [])
    .map((cityId) => Number(cityId))
    .filter((cityId) => Number.isFinite(cityId));

  if (!allowedCityIds.length) {
    return { cityId: null, allowed: false };
  }

  if (requestedCityId === null || requestedCityId === undefined) {
    return { cityId: allowedCityIds[0], allowed: true };
  }

  const numeric = Number(requestedCityId);
  if (!Number.isFinite(numeric)) {
    return { cityId: null, allowed: false };
  }

  return { cityId: numeric, allowed: allowedCityIds.includes(numeric) };
};

router.use(authenticate, attachCityScope);
// ✅ Fetch all supervisors (city-scoped; no special permission needed)
router.get("/", requireCityScope(), async (req, res) => {
  const { cityId: rawCityId } = req.query;

  let cityId = null;
  if (rawCityId && rawCityId.toString().trim().toUpperCase() !== "ALL") {
    const parsed = Number(rawCityId);
    if (!Number.isFinite(parsed)) {
      return res.status(400).json({ error: "Invalid city ID" });
    }
    cityId = parsed;
  }

  const { cityId: scopedCityId, allowed } = enforceCityScope(
    req,
    cityId ?? null
  );
  if (!allowed) {
    return res
      .status(403)
      .json({ error: "Forbidden: city not permitted for supervisors" });
  }

  try {
    let query;
    let params;

    if (scopedCityId === null) {
      // Admin with no city filter — return ALL supervisors with aggregated details
      query = `
        WITH all_assignments AS (
          SELECT user_id, ward_id FROM user_kothi_access
          UNION
          SELECT supervisor_id AS user_id, ward_id FROM supervisor_kothi
          UNION
          SELECT supervisor_id AS user_id, ward_id FROM supervisor_ward
        )
        SELECT 
          u.user_id,
          u.name,
          u.emp_code,
          u.email,
          u.phone,
          u.role,
          STRING_AGG(DISTINCT c.city_name, ', ') AS city_name,
          STRING_AGG(DISTINCT z.zone_name, ', ') AS zone_name,
          STRING_AGG(DISTINCT s.sector_name, ', ') AS ward_group,
          STRING_AGG(DISTINCT w.ward_name, ', ') AS kothi_name
        FROM users u
        LEFT JOIN all_assignments aa ON u.user_id = aa.user_id
        LEFT JOIN wards w ON aa.ward_id = w.ward_id
        LEFT JOIN sectors s ON w.sector_id = s.sector_id
        LEFT JOIN zones z ON COALESCE(s.zone_id, w.zone_id) = z.zone_id
        LEFT JOIN cities c ON z.city_id = c.city_id
        WHERE u.role = 'supervisor'
        GROUP BY u.user_id, u.name, u.emp_code, u.email, u.phone, u.role
        ORDER BY u.name ASC
      `;
      params = [];
    } else {
      // City-scoped user — return ONLY supervisors assigned to that city (via direct assignments or city access)
      query = `
        WITH all_assignments AS (
          SELECT user_id, ward_id FROM user_kothi_access
          UNION
          SELECT supervisor_id AS user_id, ward_id FROM supervisor_kothi
          UNION
          SELECT supervisor_id AS user_id, ward_id FROM supervisor_ward
        )
        SELECT 
          u.user_id,
          u.name,
          u.emp_code,
          u.email,
          u.phone,
          u.role,
          STRING_AGG(DISTINCT c.city_name, ', ') AS city_name,
          STRING_AGG(DISTINCT z.zone_name, ', ') AS zone_name,
          STRING_AGG(DISTINCT s.sector_name, ', ') AS ward_group,
          STRING_AGG(DISTINCT w.ward_name, ', ') AS kothi_name
        FROM users u
        INNER JOIN all_assignments aa ON u.user_id = aa.user_id
        INNER JOIN wards w ON aa.ward_id = w.ward_id
        INNER JOIN sectors s ON w.sector_id = s.sector_id
        INNER JOIN zones z ON COALESCE(s.zone_id, w.zone_id) = z.zone_id
        INNER JOIN cities c ON z.city_id = c.city_id
        WHERE u.role = 'supervisor'
          AND (c.city_id = $1::int OR EXISTS (
            SELECT 1 FROM user_city_access uca WHERE uca.user_id = u.user_id AND uca.city_id = $1::int
          ))
        GROUP BY u.user_id, u.name, u.emp_code, u.email, u.phone, u.role
        ORDER BY u.name ASC
      `;
      params = [scopedCityId];
    }

    const supervisors = await pool.query(query, params);
    res.json(supervisors.rows);
  } catch (error) {
    console.error("Failed to fetch supervisors:", error);
    res.status(500).json({ error: "Server error" });
  }
});
// ✅ Get city-wise supervisor counts
router.get(
  "/city-wise-count",
  requireCityScope(),
  async (req, res) => {
    try {
      const scope = req.cityScope || { all: false, ids: [] };
      const selectedCityId = req.query.cityId;

      let query = `
        SELECT 
          COALESCE(c.city_name, 'All Cities') AS city_name,
          COUNT(DISTINCT sw.supervisor_id) AS supervisor_count
        FROM (
          SELECT supervisor_id, ward_id FROM supervisor_ward
          UNION
          SELECT user_id AS supervisor_id, ward_id FROM user_kothi_access
          UNION
          SELECT supervisor_id, ward_id FROM supervisor_kothi
        ) sw
        JOIN wards w ON sw.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
      `;

      const conditions = [];
      const queryParams = [];

      if (selectedCityId && selectedCityId !== "ALL") {
        queryParams.push(Number(selectedCityId));
        conditions.push(`c.city_id = $${queryParams.length}`);
      }

      if (!scope.all && scope.ids?.length) {
        queryParams.push(scope.ids);
        conditions.push(`c.city_id = ANY($${queryParams.length}::int[])`);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }

      // ROLLUP only makes sense when fetching all cities (admin, no filter)
      const useRollup = scope.all && (!selectedCityId || selectedCityId === "ALL");

      query += useRollup
        ? ` GROUP BY ROLLUP(c.city_name) ORDER BY supervisor_count DESC`
        : ` GROUP BY c.city_name ORDER BY supervisor_count DESC`;

      const result = await pool.query(query, queryParams);

      res.json(result.rows);

    } catch (error) {
      console.error("Failed to fetch supervisor city counts:", error);
      res.status(500).json({ error: "Server error" });
    }
  }
);

router.get(
  "/city-wise-supervisors",
  requireCityScope(),
  async (req, res) => {
    try {
      const scope = req.cityScope || { all: false, ids: [] };
      const selectedCityId = req.query.cityId;

      let query = `
        SELECT
          u.user_id,
          u.name AS supervisor_name,
          u.phone,
          u.email,
          c.city_name,
          STRING_AGG(DISTINCT z.zone_name, ', ') AS zones,
          STRING_AGG(DISTINCT w.ward_name, ', ') AS kothis,
          COUNT(DISTINCT e.emp_id) AS total_employee_count
        FROM (
          SELECT supervisor_id, ward_id FROM supervisor_ward
          UNION
          SELECT user_id AS supervisor_id, ward_id FROM user_kothi_access
          UNION
          SELECT supervisor_id, ward_id FROM supervisor_kothi
        ) sw
        JOIN users u ON sw.supervisor_id = u.user_id
        JOIN wards w ON sw.ward_id = w.ward_id
        JOIN zones z ON w.zone_id = z.zone_id
        JOIN cities c ON z.city_id = c.city_id
        LEFT JOIN employee e ON e.ward_id = w.ward_id AND (e.face_id IS NOT NULL OR e.face_embedding IS NOT NULL)
      `;

      const conditions = ["u.role = 'supervisor'"];  // ← ADDED
      const queryParams = [];

      if (selectedCityId && selectedCityId !== "ALL") {
        if (
          !scope.all &&
          scope.ids?.length &&
          !scope.ids.includes(Number(selectedCityId))
        ) {
          return res.status(403).json({ error: "Unauthorized city access" });
        }

        queryParams.push(Number(selectedCityId));
        conditions.push(`c.city_id = $${queryParams.length}`);

      } else if (!scope.all && scope.ids?.length) {
        queryParams.push(scope.ids);
        conditions.push(`c.city_id = ANY($${queryParams.length}::int[])`);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }

      query += `
        GROUP BY
          u.user_id,
          u.name,
          u.phone,
          u.email,
          c.city_name
        ORDER BY
          c.city_name,
          u.name
      `;

      const result = await pool.query(query, queryParams);

      res.json(result.rows);

    } catch (error) {
      console.error("Failed to fetch city-wise supervisor details:", error);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ✅ Update Supervisor (Name, Phone, Email Only)
router.put("/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  const {
    name,
    emp_code,
    email,
    phone,
    role,
    password,
    passChange = false,
  } = req.body;

  if (!name || !emp_code || !email || !phone || !role) {
    return res.status(400).json({ error: "All fields are required" });
  }

  if (passChange && !password) {
    return res
      .status(400)
      .json({ error: "Password is required when passChange is true" });
  }

  try {
    let queryText;
    let queryParams;

    if (passChange) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      queryText = `
        UPDATE users
        SET name = $2,
            emp_code = $3,
            email = $4,
            phone = $5,
            role = $6,
            password_hash = $7
        WHERE user_id = $1
        RETURNING user_id, name, emp_code, email, phone, role
      `;
      queryParams = [id, name, emp_code, email, phone, role, hashedPassword];
    } else {
      queryText = `
        UPDATE users
        SET name = $2,
            emp_code = $3,
            email = $4,
            phone = $5,
            role = $6
        WHERE user_id = $1
        RETURNING user_id, name, emp_code, email, phone, role
      `;
      queryParams = [id, name, emp_code, email, phone, role];
    }

    const result = await pool.query(queryText, queryParams);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Supervisor not found" });
    }

    res.json({
      message: passChange
        ? "Supervisor updated with new password"
        : "Supervisor updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Failed to update supervisor:", error);
    res.status(500).json({ error: "Update failed" });
  }
});

// ✅ Delete Supervisor
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM users WHERE user_id = $1", [id]);
    res.json({ message: "Supervisor deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});
module.exports = router;
