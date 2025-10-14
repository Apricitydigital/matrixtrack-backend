const express = require("express");
const router = express.Router();
const pool = require("../config/db");

// 🛠 IST Date Formatter
const formatDateIST = (date = new Date()) => {
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
};

// 🟢 Fetch attendance report for a specific date (current date or selected date)
router.post("/", async (req, res) => {
  // Get the date from query parameters, if available; otherwise, default to IST date
  const date = req.query.date || formatDateIST(); // IST Date in YYYY-MM-DD format

  try {
    const result = await pool.query(
      `SELECT 
        ROW_NUMBER() OVER (ORDER BY a.date DESC, a.attendance_id) AS sr_no,
        attendance_id,
        e.name, 
        e.emp_code, 
        TO_CHAR(a.date, 'DD-MM-YYYY') AS date,
        w.ward_name AS ward, 
        z.zone_name AS zone, 
        c.city_name AS city, 
        e.phone AS contact_no, 
        TO_CHAR(a.punch_in_time, 'HH24:MI:SS') AS punch_in, 
        a.in_address, 
        a.punch_in_image, 
        TO_CHAR(a.punch_out_time, 'HH24:MI:SS') AS punch_out, 
        a.out_address, 
        a.punch_out_image, 
        a.duration,
        u.name AS punched_in_by,
        u1.name AS punched_out_by
      FROM attendance a
      JOIN employee e ON a.emp_id = e.emp_id
      JOIN wards w ON a.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      JOIN cities c ON z.city_id = c.city_id
      LEFT JOIN users u ON a.punched_in_by = u.user_id
      LEFT JOIN users u1 ON a.punched_out_by = u1.user_id
      WHERE a.date = $1
      ORDER BY a.date DESC, a.attendance_id;`,
      [date]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching attendance report:", error);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
