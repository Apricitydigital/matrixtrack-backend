const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const { invalidateCityAccessCache } = require("../utils/userCityAccess");
const { invalidateKothiAccessCache } = require("../utils/userKothiAccess");

// Get assignment record
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT s.assigned_id, s.supervisor_id as user_id, s.ward_id, u.emp_code, u.name, w.ward_name, z.zone_id, z.zone_name, c.city_id, c.city_name FROM supervisor_ward s JOIN users u ON s.supervisor_id = u.user_id JOIN wards w ON s.ward_id = w.ward_id JOIN zones z ON w.zone_id = z.zone_id JOIN cities c ON z.city_id = c.city_id ORDER BY u.emp_code;"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching Assigned wards: ", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Update Existing Assignment record
router.put("/:id", async (req, res) => {
  const { user_id, ward_id } = req.body;
  const assigned_id = req.params.id;

  if (!user_id || !ward_id) {
    return res.status(400).json({ error: "All fields are required" });
  }
  try {
    const result = await pool.query(
      "UPDATE supervisor_ward SET supervisor_id = $1, ward_id = $2 WHERE assigned_id = $3 RETURNING *",
      [user_id, ward_id, assigned_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "AssignedID not found" });
    }

    // Enforce that this supervisor has no other assignment rows (e.g. if updated to another supervisor who was already assigned)
    await pool.query(
      "DELETE FROM supervisor_ward WHERE supervisor_id = $1 AND assigned_id != $2",
      [user_id, assigned_id]
    );

    invalidateCityAccessCache();
    invalidateKothiAccessCache();
    res.json(result.rows[0]); // Send the updated record as a response
  } catch (error) {
    console.error("Error updating Assigned ward: ", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add new Assignment record
router.post("/", async (req, res) => {
  const { user_id, ward_id } = req.body;
  if (!user_id || !ward_id) {
    return res.status(400).json({ error: "All fields are required" });
  }
  try {
    // Check if the supervisor is already assigned to any ward
    const check = await pool.query(
      "SELECT assigned_id FROM supervisor_ward WHERE supervisor_id = $1 ORDER BY assigned_id ASC",
      [user_id]
    );

    if (check.rowCount > 0) {
      // Update the existing assignment to the new ward
      const assigned_id = check.rows[0].assigned_id;
      const result = await pool.query(
        "UPDATE supervisor_ward SET ward_id = $1 WHERE assigned_id = $2 RETURNING *",
        [ward_id, assigned_id]
      );

      // Clean up any extra duplicates if they somehow exist
      if (check.rowCount > 1) {
        const extraIds = check.rows.slice(1).map((r) => r.assigned_id);
        await pool.query(
          "DELETE FROM supervisor_ward WHERE assigned_id = ANY($1)",
          [extraIds]
        );
      }

      invalidateCityAccessCache();
      invalidateKothiAccessCache();
      return res.status(200).json(result.rows[0]);
    }

    // Otherwise, insert new assignment
    const result = await pool.query(
      `INSERT INTO supervisor_ward (supervisor_id, ward_id)
       VALUES ($1, $2)
       RETURNING *`,
      [user_id, ward_id]
    );

    invalidateCityAccessCache();
    invalidateKothiAccessCache();
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error Adding Assignment: ", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete Assignment record
router.delete("/:id", async (req, res) => {
  const assigned_id = req.params.id;
  try {
    const result = await pool.query(
      "DELETE FROM supervisor_ward WHERE assigned_id = $1 RETURNING *",
      [assigned_id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "AssignedID not found" });
    }
    invalidateCityAccessCache();
    invalidateKothiAccessCache();
    res.json({ message: "Assignment deleted successfully" });
  } catch (error) {
    console.error("Error deleting assignment: ", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
