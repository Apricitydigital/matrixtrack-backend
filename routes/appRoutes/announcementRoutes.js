const express = require("express");
const router = express.Router();
const pool = require("../../config/db");

/**
 * @route GET /api/app/config/announcements
 * @desc Get active announcements for the user role
 */
router.get("/announcements", async (req, res) => {
  try {
    const role = req.query.role || 'supervisor';
    
    const query = `
      SELECT id, title, content, created_at 
      FROM announcements 
      WHERE is_active = TRUE 
      AND (target_role = $1 OR target_role = 'all')
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(query, [role]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error("Error fetching announcements:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch announcements"
    });
  }
});

module.exports = router;
