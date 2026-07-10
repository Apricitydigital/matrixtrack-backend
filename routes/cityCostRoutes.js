const express = require("express");
const authenticateUser = require("../middleware/authMiddleware");
const pool = require("../config/db");
const {
  getCityBillingConfigs,
  getCityTrafficSummary,
  upsertCityBillingConfig,
} = require("../utils/cityTrafficCost");

const router = express.Router();
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "mtadmin@apricitydigital.in";

const requireAdmin = (req, res, next) => {
  const userRole = String(req.user?.role || "").toLowerCase();
  if (userRole !== "admin") {
    return res.status(403).json({ error: "Access denied. Admin role required." });
  }
  next();
};

const requireSuperAdminEmail = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT email FROM users WHERE user_id = $1",
      [req.user?.user_id]
    );
    const email = rows[0]?.email;
    if (String(email || "").toLowerCase() !== SUPER_ADMIN_EMAIL) {
      return res
        .status(403)
        .json({ error: "Only the super admin can view city-wise cost data." });
    }
    next();
  } catch (error) {
    console.error("Super admin check error:", error);
    res.status(500).json({ error: "Internal server error during authorization check." });
  }
};

router.use(authenticateUser);
router.use(requireAdmin);
router.use(requireSuperAdminEmail);

router.get("/configs", async (req, res) => {
  try {
    const rows = await getCityBillingConfigs();
    res.json(rows);
  } catch (error) {
    console.error("Error fetching city billing configs:", error);
    res.status(500).json({ error: "Failed to fetch city billing configs." });
  }
});

router.put("/configs/:cityId", async (req, res) => {
  try {
    const updated = await upsertCityBillingConfig({
      cityId: req.params.cityId,
      partnerName: req.body?.partner_name,
      billingModel: req.body?.billing_model,
      ratePerRequestInr: req.body?.rate_per_request_inr,
      ratePerAttendanceInr: req.body?.rate_per_attendance_inr,
      notes: req.body?.notes,
      updatedBy: req.user?.user_id,
    });
    res.json(updated);
  } catch (error) {
    console.error("Error saving city billing config:", error);
    res.status(400).json({ error: error.message || "Failed to save config." });
  }
});

router.get("/summary", async (req, res) => {
  try {
    const summary = await getCityTrafficSummary({
      fromDate: req.query?.fromDate || req.query?.from,
      toDate: req.query?.toDate || req.query?.to,
    });
    res.json(summary);
  } catch (error) {
    console.error("Error fetching city traffic summary:", error);
    res.status(500).json({ error: "Failed to fetch city traffic summary." });
  }
});

module.exports = router;
