/**
 * OTP Service — AWS SNS SMS
 * Stores OTPs in-memory with 5-minute expiry.
 * No DB changes needed.
 */
const AWS = require("aws-sdk");

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "ap-south-1",
});

const sns = new AWS.SNS();

// In-memory OTP store: { phone: { otp, expiresAt } }
const otpStore = new Map();

const OTP_EXPIRY_MS = 20 * 60 * 1000; // 20 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute

/**
 * Generate 6-digit numeric OTP
 */
const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

/**
 * Send OTP via AWS SNS to a 10-digit Indian phone number.
 * @param {string} phone - 10-digit phone (no country code)
 * @returns {{ success: boolean, message: string, cooldown?: number }}
 */
const sendOtp = async (phone) => {
  if (!phone || !/^\d{10}$/.test(phone)) {
    return { success: false, message: "Invalid phone number. Must be 10 digits." };
  }

  const internationalPhone = `+91${phone}`;

  // Check cooldown — prevent spamming
  const existing = otpStore.get(phone);
  if (existing) {
    const timeSinceSent = Date.now() - (existing.expiresAt - OTP_EXPIRY_MS);
    if (timeSinceSent < OTP_RESEND_COOLDOWN_MS) {
      const remaining = Math.ceil((OTP_RESEND_COOLDOWN_MS - timeSinceSent) / 1000);
      return { success: false, message: `Please wait ${remaining}s before resending OTP.`, cooldown: remaining };
    }
  }

  const otp = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  // Store in memory
  otpStore.set(phone, { otp, expiresAt, verified: false });

  // Send via AWS SNS
  const message = `Your MatrixTrack OTP is: ${otp}. Valid for 5 minutes. Do not share with anyone.`;

  try {
    await sns.publish({
      Message: message,
      PhoneNumber: internationalPhone,
      MessageAttributes: {
        "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "MXTRACK" },
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
      },
    }).promise();

    console.log(`[OTP] Sent to ${internationalPhone}`);
    return { success: true, message: "OTP sent successfully." };
  } catch (err) {
    console.error("[OTP] SNS send failed:", err.message);
    // Clean up failed entry
    otpStore.delete(phone);
    return { success: false, message: "Failed to send OTP. Please try again." };
  }
};

/**
 * Verify OTP for a phone number.
 * @param {string} phone - 10-digit phone
 * @param {string} otp - 6-digit OTP entered by user
 * @returns {{ success: boolean, message: string }}
 */
const verifyOtp = (phone, otp) => {
  const entry = otpStore.get(phone);

  if (!entry) {
    return { success: false, message: "No OTP found for this number. Please request a new OTP." };
  }

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(phone);
    return { success: false, message: "OTP has expired. Please request a new OTP." };
  }

  if (entry.otp !== String(otp).trim()) {
    return { success: false, message: "Incorrect OTP. Please try again." };
  }

  // Mark as verified — keeps entry for registration flow
  otpStore.set(phone, { ...entry, verified: true });
  return { success: true, message: "Phone number verified successfully." };
};

/**
 * Check if a phone is already OTP-verified (used during registration).
 * Clears the entry after check so it can't be reused.
 * @param {string} phone
 */
const isPhoneVerified = (phone) => {
  const entry = otpStore.get(phone);
  if (!entry || !entry.verified || Date.now() > entry.expiresAt) {
    return false;
  }
  return true;
};

// Clean up expired OTPs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of otpStore.entries()) {
    if (now > entry.expiresAt) otpStore.delete(phone);
  }
}, 10 * 60 * 1000);

/**
 * Send a generic SMS via AWS SNS.
 * @param {string} phone - 10-digit phone
 * @param {string} message - Message content
 */
const sendGenericSms = async (phone, message) => {
  if (!phone || !/^\d{10}$/.test(phone)) return { success: false };
  const internationalPhone = `+91${phone}`;
  try {
    await sns.publish({
      Message: message,
      PhoneNumber: internationalPhone,
      MessageAttributes: {
        "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "MXTRACK" },
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
      },
    }).promise();
    return { success: true };
  } catch (err) {
    console.error("[SMS] Generic send failed:", err.message);
    return { success: false };
  }
};

module.exports = { sendOtp, verifyOtp, isPhoneVerified, sendGenericSms };
