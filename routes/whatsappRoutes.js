const express = require("express");
const authenticateUser = require("../middleware/authMiddleware");
const {
  sendDailyWhatsAppReport,
  normalizePhoneNumber,
} = require("../utils/msg91WhatsApp");
const {
  sendDailyWhatsAppReportNew,
} = require("../utils/msg91WhatsAppNew");

const router = express.Router();

router.use(authenticateUser);

router.post("/report", async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).trim()) {
    return res.status(400).json({ error: "phoneNumber is required." });
  }

  try {
    const result = await sendDailyWhatsAppReport({
      phoneNumber,
    });

    res.json({
      providerResponse: result.providerResponse,
      reportData: result.reportData,
      phoneNumber: normalizePhoneNumber(phoneNumber),
    });
  } catch (error) {
    console.error("MSG91 WhatsApp send error:", error.provider || error);

    res.status(error.statusCode || error.response?.status || 500).json({
      error: error.message || "Unable to send WhatsApp report.",
      details: error.response?.data,
      url: error.config?.url,
    });
  }
});

router.post("/report-new", async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).trim()) {
    return res.status(400).json({ error: "phoneNumber is required." });
  }

  try {
    const result = await sendDailyWhatsAppReportNew({
      phoneNumber,
    });

    res.json({
      providerResponse: result.providerResponse,
      reportData: result.reportData,
      phoneNumber: normalizePhoneNumber(phoneNumber),
    });
  } catch (error) {
    console.error("MSG91 New WhatsApp send error:", error.provider || error);

    res.status(error.statusCode || error.response?.status || 500).json({
      error: error.message || "Unable to send new WhatsApp report.",
      details: error.response?.data,
    });
  }
});

module.exports = router;


