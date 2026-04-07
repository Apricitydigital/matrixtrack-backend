const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { invalidateKothiAccessCache } = require("../utils/userKothiAccess");
const authenticate = require("../middleware/authMiddleware");

// Get supervisor-kothi assignments
router.get("/", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        sk.assigned_id,
        sk.supervisor_id as user_id,
        sk.ward_id,
        u.emp_code,
        u.name,
        w.ward_name as kothi_name,
        s.sector_name as ward_name,
        z.zone_name,
        c.city_name
       FROM supervisor_kothi sk
       JOIN users u ON sk.supervisor_id = u.user_id
       JOIN wards w ON sk.ward_id = w.ward_id
       JOIN sectors s ON s.sector_id = w.sector_id
       JOIN zones z ON z.zone_id = s.zone_id
       JOIN cities c ON c.city_id = z.city_id
       ORDER BY u.name ASC, w.ward_name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching kothi assignments:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Add new Assignment
router.post("/", authenticate, async (req, res) => {
  const { user_id, ward_id } = req.body;
  if (!user_id || !ward_id) {
    return res.status(400).json({ error: "Supervisor ID and Kothi (Ward) ID are required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO supervisor_kothi (supervisor_id, ward_id)
       VALUES ($1, $2)
       ON CONFLICT (supervisor_id, ward_id) DO NOTHING
       RETURNING *`,
      [user_id, ward_id]
    );

    if (result.rowCount === 0) {
      const existing = await pool.query(
        "SELECT * FROM supervisor_kothi WHERE supervisor_id = $1 AND ward_id = $2",
        [user_id, ward_id]
      );
      return res.status(200).json(existing.rows[0]);
    }

    invalidateKothiAccessCache();
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error adding kothi assignment:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Update Assignment
router.put("/:id", authenticate, async (req, res) => {
  const { user_id, ward_id } = req.body;
  const { id } = req.params;

  if (!user_id || !ward_id) {
    return res.status(400).json({ error: "Supervisor ID and Kothi (Ward) ID are required" });
  }

  try {
    const result = await pool.query(
      "UPDATE supervisor_kothi SET supervisor_id = $1, ward_id = $2 WHERE assigned_id = $3 RETURNING *",
      [user_id, ward_id, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    invalidateKothiAccessCache();
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating kothi assignment:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Delete Assignment
router.delete("/:id", authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM supervisor_kothi WHERE assigned_id = $1 RETURNING *",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Assignment not found" });
    }
    invalidateKothiAccessCache();
    res.json({ message: "Assignment deleted successfully" });
  } catch (error) {
    console.error("Error deleting kothi assignment:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
