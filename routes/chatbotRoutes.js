const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../config/db"); // Import DB to fetch MatrixTrack data

router.post("/", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === "your_actual_openai_api_key_here") {
    return res.status(500).json({ error: "OpenAI API key not configured or invalid" });
  }

  try {
    // 1. Fetch live MatrixTrack Data to provide context to ChatGPT
    const employeeCountResult = await pool.query("SELECT COUNT(*) FROM employee");
    const totalEmployees = parseInt(employeeCountResult.rows[0].count) || 0;

    const todayStats = await pool.query(`
      SELECT
        COUNT(DISTINCT CASE WHEN punch_in_time IS NOT NULL THEN emp_id END) as present_today
      FROM attendance
      WHERE date = CURRENT_DATE
    `);
    const presentToday = parseInt(todayStats.rows[0].present_today) || 0;
    const absentToday = totalEmployees - presentToday;

    const systemPrompt = `You are the MatrixTrack AI Assistant for the admin dashboard. 
Your goal is to answer the admin's questions based ONLY on the following real-time MatrixTrack system data:

Today's MatrixTrack Data:
- Total Registered Employees: ${totalEmployees}
- Employees Present Today: ${presentToday}
- Employees Absent Today: ${absentToday}
- Overall Attendance Rate Today: ${((presentToday / totalEmployees) * 100).toFixed(1)}%

Be concise, helpful, and professional. If the admin asks for data you don't have in the summary above, politely explain that you currently only have access to the daily high-level attendance summary.`;

    // 2. Send both system context and user message to ChatGPT
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const reply = response.data.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error("Chatbot API Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch response from chatbot" });
  }
});

module.exports = router;
