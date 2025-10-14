const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// Get all wards with zone names
// router.get("/", async (req, res) => {
//   try {
//     const result = await pool.query(
//       `SELECT w.ward_id, w.ward_name, z.zone_id,
//     z.zone_name,
//     c.city_id,
//     c.city_name
// FROM wards w
// JOIN zones z ON w.zone_id = z.zone_id
// JOIN cities c ON z.city_id = c.city_id;`
//     );
//     res.json(result.rows);
//   } catch (error) {
//     console.error("Error fetching wards:", error);
//     res.status(500).json({ error: "Internal Server Error" });
//   }
// });

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.ward_id, w.ward_name, z.zone_id, 
              z.zone_name, c.city_id, c.city_name
       FROM wards w
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id;`
    );

    const groupedData = {};

    result.rows.forEach((row) => {
      const { city_id, city_name, zone_id, zone_name, ward_id, ward_name } =
        row;

      if (!groupedData[city_id]) {
        groupedData[city_id] = {
          cityId: city_id,
          city: city_name,
          zones: {},
        };
      }

      if (!groupedData[city_id].zones[zone_id]) {
        groupedData[city_id].zones[zone_id] = {
          zoneId: zone_id,
          zone: zone_name,
          wards: [],
        };
      }

      groupedData[city_id].zones[zone_id].wards.push({
        wardId: ward_id,
        wardName: ward_name,
      });
    });

    // Convert grouped data into an array format
    const responseData = Object.values(groupedData).map((city) => ({
      ...city,
      zones: Object.values(city.zones),
    }));

    res.json(responseData);
  } catch (error) {
    console.error("Error fetching wards:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Get a specific ward by ID
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT w.ward_id, w.ward_name, z.zone_id, z.zone_name 
       FROM wards w
       JOIN zones z ON w.zone_id = z.zone_id
       WHERE w.ward_id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ward not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching ward:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Create a new ward
router.post("/", async (req, res) => {
  const { ward_name, zone_id } = req.body;
  if (!ward_name || !zone_id) {
    return res
      .status(400)
      .json({ error: "Ward name and Zone ID are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO wards (ward_name, zone_id) 
       VALUES ($1, $2) 
       RETURNING *`,
      [ward_name, zone_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating ward:", error);
    if (error.constraint === "unique_ward_per_zone") {
      return res
        .status(409)
        .json({ error: "Ward already exists in this zone" });
    }
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Update a ward
router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { ward_name, zone_id } = req.body;

  try {
    const result = await pool.query(
      `UPDATE wards SET ward_name = $1, zone_id = $2 
       WHERE ward_id = $3 
       RETURNING *`,
      [ward_name, zone_id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ward not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating ward:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Delete a ward
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM wards WHERE ward_id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ward not found" });
    }
    res.json({ message: "Ward deleted successfully" });
  } catch (error) {
    console.error("Error deleting ward:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
