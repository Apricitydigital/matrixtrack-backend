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

const maskPhone = (phone) => {
  const normalized = String(phone || "").replace(/\D/g, "");
  if (normalized.length < 4) return normalized || "unknown";
  return `+91XXXXXX${normalized.slice(-4)}`;
};

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
  const maskedPhone = maskPhone(phone);
  const requestIp = req.ip || req.connection?.remoteAddress || "unknown";

  if (!phone || !/^\d{10}$/.test(String(phone).trim())) {
    console.warn(`[OTPRoute] send rejected invalid phone ip=${requestIp} phone=${maskedPhone}`);
    return res.status(400).json({ error: "Phone must be exactly 10 digits." });
  }

  console.log(`[OTPRoute] send requested ip=${requestIp} phone=${maskedPhone}`);
  const result = await sendOtp(String(phone).trim());

  if (!result.success) {
    console.warn(`[OTPRoute] send failed ip=${requestIp} phone=${maskedPhone} message="${result.message}"`);
    return res.status(result.cooldown ? 429 : 500).json({ error: result.message, cooldown: result.cooldown });
  }

  console.log(`[OTPRoute] send success ip=${requestIp} phone=${maskedPhone}`);
  return res.json({ message: result.message });
});

/**
 * POST /api/otp/verify
 * Body: { phone: "9876543210", otp: "123456" }
 */
router.post("/verify", rateLimit, (req, res) => {
  const { phone, otp } = req.body;
  const maskedPhone = maskPhone(phone);
  const requestIp = req.ip || req.connection?.remoteAddress || "unknown";

  if (!phone || !otp) {
    console.warn(`[OTPRoute] verify rejected missing fields ip=${requestIp} phone=${maskedPhone}`);
    return res.status(400).json({ error: "Phone and OTP are required." });
  }

  if (!/^\d{6}$/.test(String(otp).trim())) {
    console.warn(`[OTPRoute] verify rejected invalid otp format ip=${requestIp} phone=${maskedPhone}`);
    return res.status(400).json({ error: "OTP must be exactly 6 digits." });
  }

  console.log(`[OTPRoute] verify requested ip=${requestIp} phone=${maskedPhone}`);
  const result = verifyOtp(String(phone).trim(), String(otp).trim());

  if (!result.success) {
    console.warn(`[OTPRoute] verify failed ip=${requestIp} phone=${maskedPhone} message="${result.message}"`);
    return res.status(400).json({ error: result.message });
  }

  console.log(`[OTPRoute] verify success ip=${requestIp} phone=${maskedPhone}`);
  return res.json({ message: result.message, verified: true });
});

module.exports = router;
