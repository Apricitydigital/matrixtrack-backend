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
const {
  sendZoneCommissionerWhatsAppReport,
} = require("../utils/msg91ZoneCommissionerReport");

const {
  getReportSettings,
  setReportStatus,
} = require("../utils/whatsappSettings");

const router = express.Router();

router.use(authenticateUser);
router.use((req, res, next) => {
  if (String(req.user?.role).toLowerCase() !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
});

// Settings Endpoints
router.get("/settings", async (req, res) => {
  try {
    const settings = await getReportSettings();
    const { zoneRecipients } = require('../utils/zoneBriefScheduler');
    res.json({
      success: true, settings, zoneSchedules: [1, 2, 3, 4, 5].map(n => ({
        reportId: 'zone-commissioner-zone-' + n,
        enabled: process.env.WHATSAPP_CRON_ENABLED === 'true' && zoneRecipients(n).length > 0,
        recipientsCount: zoneRecipients(n).length,
        recipients: zoneRecipients(n)
      }))
    });
  } catch (error) {
    console.error("Error fetching WhatsApp report settings:", error);
    res.status(500).json({ error: "Unable to fetch WhatsApp report settings." });
  }
});

router.post("/settings", async (req, res) => {
  const { reportId, reportName, status } = req.body || {};
  if (!reportId || !status) {
    return res.status(400).json({ error: "reportId and status are required." });
  }

  try {
    const updated = await setReportStatus(reportId, reportName, status);
    res.json({ success: true, setting: updated });
  } catch (error) {
    console.error("Error updating WhatsApp report setting:", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unable to update WhatsApp report setting." });
  }
});

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
  const enabled = await isReportEnabled("daily-city-report");
  if (!enabled) {
    return res.status(403).json({
      error: "Daily PMC Workforce Status WhatsApp report is currently disabled/paused.",
      disabled: true,
    });
  }

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

router.post("/zone-commissioner", async (req, res) => {
  const { phoneNumber, zoneName, zoneData } = req.body || {};
  const targetZone = zoneName || zoneData?.zoneName || "Zone 1";
  if (!phoneNumber || !String(phoneNumber).trim()) {
    return res.status(400).json({ error: "phoneNumber is required." });
  }

  try {
    const result = await sendZoneCommissionerWhatsAppReport({
      phoneNumber,
      zoneName: targetZone,
      zoneData,
    });

    res.json({
      message: `${targetZone} Commissioner WhatsApp Report sent successfully!`,
      phoneNumber: result.phoneNumber,
      reportData: result.reportData,
      providerResponse: result.providerResponse,
    });
  } catch (error) {
    console.error("Zone Commissioner WhatsApp send error:", error);
    res.status(error.statusCode || error.response?.status || 500).json({
      error: error.message || "Unable to send Zone Commissioner report.",
      details: error.response?.data,
    });
  }
});

router.post("/zone-commissioner/send-all-zones", async (req, res) => {
  const { phoneNumber, dateISO } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).trim()) {
    return res.status(400).json({ error: "phoneNumber is required." });
  }

  const zones = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"];
  const results = [];
  const errors = [];

  for (const zone of zones) {
    try {
      const result = await sendZoneCommissionerWhatsAppReport({
        phoneNumber,
        zoneName: zone,
        zoneData: { zoneName: zone, dateISO },
      });
      results.push({
        zone,
        success: true,
        reportData: result.reportData,
        requestId: result.providerResponse?.request_id,
      });
    } catch (err) {
      console.error(`Failed to send Zone Commissioner report for ${zone}:`, err.message);
      errors.push({ zone, success: false, error: err.message });
    }
  }

  res.json({
    message: `${results.length} reports queued; ${errors.length} reports blocked or failed.`,
    results,
    errors,
  });
});

module.exports = router;
