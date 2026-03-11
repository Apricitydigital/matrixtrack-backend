const express = require("express");
const router = express.Router();
const pool = require("../../config/db");

/**
 * @route GET /api/app/config/feedback
 * @desc Get active feedback question
 */
router.get("/", async (req, res) => {
  try {
    const query = "SELECT id, question FROM feedback_config WHERE is_active = TRUE ORDER BY created_at ASC";
    const result = await pool.query(query);
    
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (error) {
    console.error("Error fetching feedback config:", error);
    res.status(500).json({ success: false, message: "Failed to fetch feedback questions" });
  }
});

/**
 * @route POST /api/app/config/feedback/submit
 * @desc Submit feedback response
 */
router.post("/submit", async (req, res) => {
  try {
    const { user_id, responses } = req.body;
    
    if (!user_id || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ success: false, message: "User ID and responses are required" });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const resp of responses) {
        const { rating, comment, config_id } = resp;
        const query = `
          INSERT INTO feedback_responses (user_id, rating, comment, config_id)
          VALUES ($1, $2, $3, $4)
        `;
        await client.query(query, [user_id, rating, comment, config_id]);
      }
      await client.query('COMMIT');
      res.json({ success: true, message: "Feedback submitted successfully" });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error submitting feedback:", error);
    res.status(500).json({ success: false, message: "Failed to submit feedback" });
  }
});

module.exports = router;
