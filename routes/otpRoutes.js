/**
 * OTP Routes — Send & Verify via AWS SNS
 * POST /api/otp/send    — send OTP to phone
 * POST /api/otp/verify  — verify OTP
 *
 * These are PUBLIC endpoints (no auth needed — used before registration).
 */
const express = require("express");
const router = express.Router();
const { sendOtp, verifyOtp } = require("../utils/otpService");

// Basic rate limiting: max 5 requests per IP per minute
const ipRequestMap = new Map();
const rateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 5;

  if (!ipRequestMap.has(ip)) {
    ipRequestMap.set(ip, []);
  }

  const requests = ipRequestMap.get(ip).filter((t) => now - t < windowMs);
  if (requests.length >= maxRequests) {
    return res.status(429).json({ error: "Too many requests. Please wait a minute." });
  }

  requests.push(now);
  ipRequestMap.set(ip, requests);
  next();
};

// Clean IP map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of ipRequestMap.entries()) {
    const valid = times.filter((t) => now - t < 60 * 1000);
    if (!valid.length) ipRequestMap.delete(ip);
    else ipRequestMap.set(ip, valid);
  }
}, 5 * 60 * 1000);

/**
 * POST /api/otp/send
 * Body: { phone: "9876543210" }
 */
router.post("/send", rateLimit, async (req, res) => {
  const { phone } = req.body;

  if (!phone || !/^\d{10}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: "Phone must be exactly 10 digits." });
  }

  const result = await sendOtp(String(phone).trim());

  if (!result.success) {
    return res.status(result.cooldown ? 429 : 500).json({ error: result.message, cooldown: result.cooldown });
  }

  return res.json({ message: result.message });
});

/**
 * POST /api/otp/verify
 * Body: { phone: "9876543210", otp: "123456" }
 */
router.post("/verify", rateLimit, (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: "Phone and OTP are required." });
  }

  if (!/^\d{6}$/.test(String(otp).trim())) {
    return res.status(400).json({ error: "OTP must be exactly 6 digits." });
  }

  const result = verifyOtp(String(phone).trim(), String(otp).trim());

  if (!result.success) {
    return res.status(400).json({ error: result.message });
  }

  return res.json({ message: result.message, verified: true });
});

module.exports = router;
