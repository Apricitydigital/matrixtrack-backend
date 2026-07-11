const nodemailer = require("nodemailer");
require("dotenv").config();

// Pre-configure Nodemailer
// In production, consider using process.env for these values
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER || "your-email@gmail.com", // Replace with actual or set in .env
    pass: process.env.EMAIL_PASS || "your-app-password",    // Replace with actual or set in .env
  },
});

/**
 * Sends a generic email
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Plain text body
 * @param {string} html - HTML body (optional)
 */
async function sendEmail(to, subject, text, html = "") {
  try {
    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER || "your-email@gmail.com",
      to,
      subject,
      text,
      html: html || text, // Fallback to text if html is empty
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: " + info.response);
    return { success: true, info };
  } catch (error) {
    console.error("Error sending email:", error);
    // Even if it fails, we return false rather than throwing so the server doesn't crash
    return { success: false, error };
  }
}

/**
 * Sends the 2FA OTP email
 * @param {string} to - Recipient email
 * @param {string} otp - The 6 digit OTP
 */
async function sendOTPEmail(to, otp) {
  const subject = "Your Admin Login OTP";
  const text = `Your One-Time Password (OTP) for Matrix Track Admin Login is: ${otp}. It is valid for 5 minutes. Do not share it with anyone.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #4A90E2; text-align: center;">Matrix Track Login Verification</h2>
      <p style="font-size: 16px; color: #333;">Hello,</p>
      <p style="font-size: 16px; color: #333;">A login attempt was made to your Admin account. Please use the following OTP to complete the login process:</p>
      <div style="text-align: center; margin: 30px 0;">
        <span style="display: inline-block; padding: 15px 30px; font-size: 24px; font-weight: bold; background-color: #f4f4f4; border-radius: 5px; letter-spacing: 4px;">${otp}</span>
      </div>
      <p style="font-size: 14px; color: #666;">This OTP is valid for <strong>5 minutes</strong>. If you did not request this, please secure your account immediately.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="font-size: 12px; color: #999; text-align: center;">© ${new Date().getFullYear()} Matrix Track. All rights reserved.</p>
    </div>
  `;
  return sendEmail(to, subject, text, html);
}

module.exports = {
  sendEmail,
  sendOTPEmail,
};
