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
    const supervisors = await pool.query(
      `
        SELECT DISTINCT ON (u.user_id)
          u.user_id,
          u.name,
          u.emp_code,
          u.email,
          u.phone,
          u.role,
          c.city_id,
          c.city_name
        FROM users u
        LEFT JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
        LEFT JOIN wards w ON sw.ward_id = w.ward_id
        LEFT JOIN zones z ON w.zone_id = z.zone_id
        LEFT JOIN cities c ON z.city_id = c.city_id
        WHERE u.role = 'supervisor'
          AND (
            $1::int IS NULL
            OR c.city_id = $1::int
            OR NOT EXISTS (
              SELECT 1 FROM supervisor_ward sw2 WHERE sw2.supervisor_id = u.user_id
            )
          )
        ORDER BY u.user_id, u.name
      `,
      [scopedCityId ?? null]
    );
    res.json(supervisors.rows);
  } catch (error) {
    console.error("Failed to fetch supervisors:", error);
    res.status(500).json({ error: "Server error" });
  }
});

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
