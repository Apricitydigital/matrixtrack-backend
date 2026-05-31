const express = require("express");
const authenticateUser = require("../middleware/authMiddleware");
const {
  sendDailyWhatsAppReport,
  normalizePhoneNumber,
} = require("../utils/msg91WhatsApp");
const {
  sendDailyWhatsAppReportNew,
} = require("../utils/msg91WhatsAppNew");
const {
  generateDailyBulletin,
} = require("../utils/msg91DailyBulletin");

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

router.post("/daily-bulletin", async (req, res) => {
  const { phoneNumber, date } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).trim()) {
    return res.status(400).json({ error: "phoneNumber is required." });
  }

  try {
    const data = await generateDailyBulletin(date);

    // Prepare template components mapping so they can see exactly what gets sent!
    const templateComponents = {
      body_1: data.date,
      body_2: data.statusText,
      body_3: data.statusDesc,
      body_4: data.cityRegistered,
      body_5: data.cityPresent,
      body_6: data.cityLeave,
      body_7: data.cityAbsent,
      body_8: data.zoneOverviewText,
      body_9: data.detailedZoneText,
      body_10: data.keyObservation,
      body_11: data.tomorrowFocusZonesStr,
      body_12: data.manualPunchZonesStr,
    };

    res.json({
      message: "Daily bulletin data generated successfully! (MSG91 Call will be integrated once template is approved)",
      phoneNumber: normalizePhoneNumber(phoneNumber),
      templateComponents,
      rawPreviewText: data.rawPreviewText,
    });
  } catch (error) {
    console.error("Daily bulletin generation error:", error);
    res.status(500).json({
      error: error.message || "Unable to generate daily bulletin report data.",
    });
  }
});

module.exports = router;
