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
  sendDailyBulletinWhatsAppNew,
} = require("../utils/msg91DailyBulletinNew");

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
    const result = await sendDailyBulletinWhatsAppNew({
      phoneNumber,
      date,
    });

    const z0 = result.reportData.zonesData[0] || { zoneName: "", registered: 0, present: 0, leave: 0, absent: 0 };
    const z1 = result.reportData.zonesData[1] || { zoneName: "", registered: 0, present: 0, leave: 0, absent: 0 };
    const z2 = result.reportData.zonesData[2] || { zoneName: "", registered: 0, present: 0, leave: 0, absent: 0 };
    const z3 = result.reportData.zonesData[3] || { zoneName: "", registered: 0, present: 0, leave: 0, absent: 0 };
    const z4 = result.reportData.zonesData[4] || { zoneName: "", registered: 0, present: 0, leave: 0, absent: 0 };

    // Prepare template components mapping so they can see exactly what got sent!
    const templateComponents = {
      body_1: result.reportData.date,
      body_2: result.reportData.statusText,
      body_3: result.reportData.statusDesc,
      body_4: result.reportData.cityRegistered,
      body_5: result.reportData.cityPresent,
      body_6: result.reportData.cityLeave,
      body_7: result.reportData.cityAbsent,
      body_8: result.reportData.overviewLines[0] || "-",
      body_9: result.reportData.overviewLines[1] || "-",
      body_10: result.reportData.overviewLines[2] || "-",
      body_11: result.reportData.overviewLines[3] || "-",
      body_12: result.reportData.overviewLines[4] || "-",
      body_13: z0.zoneName || "-",
      body_14: String(z0.registered),
      body_15: String(z0.present),
      body_16: String(z0.leave),
      body_17: String(z0.absent),
      body_18: z1.zoneName || "-",
      body_19: String(z1.registered),
      body_20: String(z1.present),
      body_21: String(z1.leave),
      body_22: String(z1.absent),
      body_23: z2.zoneName || "-",
      body_24: String(z2.registered),
      body_25: String(z2.present),
      body_26: String(z2.leave),
      body_27: String(z2.absent),
      body_28: z3.zoneName || "-",
      body_29: String(z3.registered),
      body_30: String(z3.present),
      body_31: String(z3.leave),
      body_32: String(z3.absent),
      body_33: z4.zoneName || "-",
      body_34: String(z4.registered),
      body_35: String(z4.present),
      body_36: String(z4.leave),
      body_37: String(z4.absent),
      body_38: result.reportData.keyObservation,
      body_39: result.reportData.tomorrowFocusZonesStr,
      body_40: result.reportData.manualPunchZonesStr,
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
