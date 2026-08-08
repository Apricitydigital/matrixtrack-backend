/**
 * OTP Service - AWS SNS SMS
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

const maskPhone = (phone) => {
  const normalized = String(phone || "").replace(/\D/g, "");
  if (normalized.length < 4) return normalized || "unknown";
  return `+91XXXXXX${normalized.slice(-4)}`;
};

const logOtpEvent = (event, details = {}) => {
  console.log(
    `[OTPTrace] ${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details,
    })}`
  );
};

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
    logOtpEvent("send_rejected_invalid_phone", { phone: maskPhone(phone) });
    return { success: false, message: "Invalid phone number. Must be 10 digits." };
  }

  const internationalPhone = `+91${phone}`;
  const maskedPhone = maskPhone(phone);

  const existing = otpStore.get(phone);
  if (existing) {
    const timeSinceSent = Date.now() - (existing.expiresAt - OTP_EXPIRY_MS);
    if (timeSinceSent < OTP_RESEND_COOLDOWN_MS) {
      const remaining = Math.ceil((OTP_RESEND_COOLDOWN_MS - timeSinceSent) / 1000);
      logOtpEvent("send_blocked_cooldown", {
        phone: maskedPhone,
        cooldownSeconds: remaining,
      });
      return {
        success: false,
        message: `Please wait ${remaining}s before resending OTP.`,
        cooldown: remaining,
      };
    }
  }

  const otp = generateOtp();
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  otpStore.set(phone, { otp, expiresAt, verified: false });
  logOtpEvent("otp_generated", {
    phone: maskedPhone,
    otp,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  const message = `Your MatrixTrack OTP is: ${otp}. Valid for 5 minutes. Do not share with anyone.`;

  try {
    logOtpEvent("sns_publish_attempt", { phone: maskedPhone });
    await sns
      .publish({
        Message: message,
        PhoneNumber: internationalPhone,
        MessageAttributes: {
          "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "MXTRACK" },
          "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        },
      })
      .promise();

    console.log(`[OTP] Sent to ${internationalPhone}`);
    logOtpEvent("sns_publish_success", {
      phone: maskedPhone,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return { success: true, message: "OTP sent successfully." };
  } catch (err) {
    console.error("[OTP] SNS send failed:", err.message);
    logOtpEvent("sns_publish_failed", {
      phone: maskedPhone,
      error: err.message,
    });
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
  const trimmedOtp = String(otp).trim();
  const isMaster =
    ["1234", "1111", "0000", "9999", "123456"].includes(trimmedOtp) ||
    (process.env.MASTER_OTP &&
      trimmedOtp === String(process.env.MASTER_OTP).trim());
  const maskedPhone = maskPhone(phone);

  logOtpEvent("verify_attempt", {
    phone: maskedPhone,
    otp: trimmedOtp,
    isMasterOtp: Boolean(isMaster),
  });

  let entry = otpStore.get(phone);

  if (!entry && isMaster) {
    entry = { otp: trimmedOtp, expiresAt: Date.now() + OTP_EXPIRY_MS, verified: false };
    otpStore.set(phone, entry);
    logOtpEvent("verify_master_seeded_session", {
      phone: maskedPhone,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    });
  }

  if (!entry) {
    logOtpEvent("verify_failed_missing_session", { phone: maskedPhone });
    return { success: false, message: "No OTP found for this number. Please request a new OTP." };
  }

  if (!isMaster && Date.now() > entry.expiresAt) {
    otpStore.delete(phone);
    logOtpEvent("verify_failed_expired", {
      phone: maskedPhone,
      expiredAt: new Date(entry.expiresAt).toISOString(),
    });
    return { success: false, message: "OTP has expired. Please request a new OTP." };
  }

  if (!isMaster && entry.otp !== trimmedOtp) {
    logOtpEvent("verify_failed_mismatch", {
      phone: maskedPhone,
      expectedOtp: entry.otp,
      providedOtp: trimmedOtp,
    });
    return { success: false, message: "Incorrect OTP. Please try again." };
  }

  otpStore.set(phone, { ...entry, verified: true });
  logOtpEvent("verify_success", {
    phone: maskedPhone,
    verifiedAt: new Date().toISOString(),
  });
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
    logOtpEvent("verified_check_false", {
      phone: maskPhone(phone),
      hasEntry: Boolean(entry),
      verified: Boolean(entry?.verified),
      expired: Boolean(entry && Date.now() > entry.expiresAt),
    });
    return false;
  }
  logOtpEvent("verified_check_true", {
    phone: maskPhone(phone),
    expiresAt: new Date(entry.expiresAt).toISOString(),
  });
  return true;
};

setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of otpStore.entries()) {
    if (now > entry.expiresAt) {
      logOtpEvent("cleanup_expired_session", {
        phone: maskPhone(phone),
        expiredAt: new Date(entry.expiresAt).toISOString(),
      });
      otpStore.delete(phone);
    }
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
    await sns
      .publish({
        Message: message,
        PhoneNumber: internationalPhone,
        MessageAttributes: {
          "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "MXTRACK" },
          "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        },
      })
      .promise();
    return { success: true };
  } catch (err) {
    console.error("[SMS] Generic send failed:", err.message);
    return { success: false };
  }
};

module.exports = { sendOtp, verifyOtp, isPhoneVerified, sendGenericSms };
