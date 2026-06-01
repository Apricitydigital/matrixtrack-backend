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
  sendDailyBulletinWhatsApp,
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
    const result = await sendDailyBulletinWhatsApp({
      phoneNumber,
      date,
    });

    // Prepare template components mapping so they can see exactly what got sent!
    const templateComponents = {
      body_1: result.reportData.date,
      body_2: result.reportData.statusText,
      body_3: result.reportData.statusDesc,
      body_4: result.reportData.cityRegistered,
      body_5: result.reportData.cityPresent,
      body_6: result.reportData.cityLeave,
      body_7: result.reportData.cityAbsent,
      body_8: result.reportData.zoneOverviewText,
      body_9: result.reportData.detailedZoneText,
      body_10: result.reportData.keyObservation,
      body_11: result.reportData.tomorrowFocusZonesStr,
      body_12: result.reportData.manualPunchZonesStr,
    };

    res.json({
      message: "Daily bulletin WhatsApp report sent successfully!",
      phoneNumber: result.phoneNumber,
      providerResponse: result.providerResponse,
      templateComponents,
      rawPreviewText: result.reportData.rawPreviewText,
    });
  } catch (error) {
    console.error("Daily bulletin sending error:", error);
    res.status(error.statusCode || error.response?.status || 500).json({
      error: error.message || "Unable to send daily bulletin report.",
      details: error.response?.data,
    });
  }
});

module.exports = router;
