const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");

// 🛠 IST Date Formatter
const formatDateIST = (date = new Date()) => {
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
};

/**
 * @route GET /api/supervisor-audit
 * @desc Fetch punch-in and punch-out counts performed by supervisors within a date range
 * @access Admin only (verified by middleware and role check in UI)
 */
router.get("/", authenticate, async (req, res) => {
  const { startDate, endDate, cityId, zoneId, sectorId, wardId } = req.query;
  
  try {
    // Default to today if no dates provided
    const start = startDate && startDate !== "" && startDate !== "undefined" ? startDate : formatDateIST();
    const end = endDate && endDate !== "" && endDate !== "undefined" ? endDate : start;

    const params = [start, end];

    const query = `
      SELECT 
        c.city_id,
        z.zone_id,
        s.sector_id,
        w.ward_id,
        c.city_name,
        z.zone_name,
        s.sector_name AS ward_name,
        w.ward_name AS kothi_name,
        u.name AS supervisor_name,
        u.phone AS supervisor_phone,
        COUNT(DISTINCT a_in.attendance_id) AS total_punch_in,
        COUNT(DISTINCT a_out.attendance_id) AS total_punch_out
      FROM users u
      JOIN supervisor_ward sw ON u.user_id = sw.supervisor_id
      JOIN wards w ON sw.ward_id = w.ward_id
      LEFT JOIN sectors s ON w.sector_id = s.sector_id
      LEFT JOIN zones z ON s.zone_id = z.zone_id
      LEFT JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN attendance a_in ON a_in.punched_in_by = u.user_id 
        AND a_in.ward_id = w.ward_id 
        AND a_in.date::date >= $1 AND a_in.date::date <= $2
      LEFT JOIN attendance a_out ON a_out.punched_out_by = u.user_id 
        AND a_out.ward_id = w.ward_id 
        AND a_out.date::date >= $1 AND a_out.date::date <= $2
      WHERE u.role = 'supervisor'
      GROUP BY c.city_id, z.zone_id, s.sector_id, w.ward_id, c.city_name, z.zone_name, s.sector_name, w.ward_name, u.name, u.phone
      ORDER BY c.city_name, z.zone_name, s.sector_name, w.ward_name, u.name;
    `;

    const result = await pool.query(query, params);
    res.json(result.rows || []);
  } catch (error) {
    console.error("Error in supervisor audit:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

module.exports = router;
