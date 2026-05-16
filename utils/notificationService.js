const nodemailer = require("nodemailer");
const axios = require("axios");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

// AWS Config
const awsConfig = {
  region: process.env.AWS_REGION || "ap-south-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
};

// SNS Client for SMS
const snsClient = new SNSClient(awsConfig);

// Email Transporter (Placeholder - user needs to provide SMTP details or use AWS SES)
// For now, setting up a structure that can be easily configured.
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: process.env.EMAIL_PORT || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Send Welcome Email functionality removed as per user request.


/**
 * Send Welcome WhatsApp Message via MSG91
 * Selects template based on the city (Marathi for Pune, Hindi for others)
 */
const sendWelcomeWhatsApp = async (user, plainPassword, cityName = "", zoneName = "Unassigned", wardName = "Unassigned", kothiName = "Unassigned") => {
  const AUTH_KEY = process.env.MSG91_AUTH_KEY;
  const INTEGRATED_NUMBER = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER;
  const TEMPLATE_NAMESPACE = process.env.MSG91_WHATSAPP_TEMPLATE_NAMESPACE;
  
  // Use a single English template for everyone
  const TEMPLATE_NAME = process.env.MSG91_WHATSAPP_WELCOME_TEMPLATE || "welcome_general_english";
  console.log(`[NotificationService] Attempting to send WhatsApp to ${user.phone} using template: ${TEMPLATE_NAME}`);


  if (!AUTH_KEY || !INTEGRATED_NUMBER || !TEMPLATE_NAME) {
    console.warn("[NotificationService] MSG91 config missing (Template Name). Skipping WhatsApp.");
    return;
  }

  const normalizedPhone = user.phone.length === 10 ? `91${user.phone}` : user.phone;

  const payload = {
    integrated_number: INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
      messaging_product: "whatsapp",
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        namespace: TEMPLATE_NAMESPACE,
        language: {
          policy: "deterministic",
          code: "en",
        },
        to_and_components: [
          {
            to: [normalizedPhone],
            components: {
              body_1: { type: "text", value: user.name },
              body_2: { type: "text", value: user.email },
              body_3: { type: "text", value: user.phone },
              body_4: { type: "text", value: plainPassword },
              body_5: { type: "text", value: zoneName },
              body_6: { type: "text", value: wardName },
              body_7: { type: "text", value: kothiName },
            },
          },
        ],
      },
    },
  };

  try {
    const response = await axios.post(
      "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          authkey: AUTH_KEY,
        },
      }
    );
    console.log(`[NotificationService] WhatsApp sent (English):`, response.data);
    return response.data;
  } catch (error) {
    console.error("[NotificationService] WhatsApp error:", error.response?.data || error.message);
  }
};

/**
 * Send Welcome SMS via AWS SNS
 */
const sendWelcomeSms = async (user, plainPassword, cityName = "", zoneName = "Unassigned", wardName = "Unassigned", kothiName = "Unassigned") => {
  console.log(`[NotificationService] Attempting to send Welcome SMS to ${user.phone}`);
  if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn("[NotificationService] AWS credentials missing for SMS. Skipping SMS.");
    return;
  }

  const normalizedPhone = user.phone.length === 10 ? `+91${user.phone}` : (user.phone.startsWith("+") ? user.phone : `+${user.phone}`);

  const message = `Hello ${user.name},
Welcome to MatrixTrack! Your registration as a Supervisor is successful.
Email: ${user.email}
Mobile: ${user.phone}
Password: ${plainPassword}
Zone: ${zoneName}
Ward: ${wardName}
Kothi: ${kothiName}

Thank you. Please download MatrixTrack from your App Store or Play Store.`;

  const params = {
    Message: message,
    PhoneNumber: normalizedPhone,
    MessageAttributes: {
      "AWS.SNS.SMS.SenderID": {
        DataType: "String",
        StringValue: "MTRACK",
      },
      "AWS.SNS.SMS.SMSType": {
        DataType: "String",
        StringValue: "Transactional",
      },
    },
  };


  try {
    const data = await snsClient.send(new PublishCommand(params));
    console.log("[NotificationService] SMS sent successfully:", data.MessageId);
    return data;
  } catch (error) {
    console.error("[NotificationService] SMS error:", error.message);
  }
};

/**
 * Send Password Update SMS via AWS SNS
 */
const sendPasswordUpdateSms = async (user, newPassword) => {
  if (!process.env.AWS_ACCESS_KEY || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn("[NotificationService] AWS credentials missing for Password Update SMS.");
    return;
  }

  const normalizedPhone = user.phone.length === 10 ? `+91${user.phone}` : (user.phone.startsWith("+") ? user.phone : `+${user.phone}`);

  const message = `Hello ${user.name},
Your MatrixTrack login password has been successfully updated.

Email: ${user.email}
Mobile: ${user.phone}
New Password: ${newPassword}

Please keep your credentials secure. Thank you!`;

  const params = {
    Message: message,
    PhoneNumber: normalizedPhone,
    MessageAttributes: {
      "AWS.SNS.SMS.SenderID": { DataType: "String", StringValue: "MTRACK" },
      "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
    },
  };

  try {
    const data = await snsClient.send(new PublishCommand(params));
    console.log("[NotificationService] Password update SMS sent:", data.MessageId);
    return data;
  } catch (error) {
    console.error("[NotificationService] Password update SMS error:", error.message);
  }
};

module.exports = {
  sendWelcomeWhatsApp,
  sendWelcomeSms,
  sendPasswordUpdateSms,
};
