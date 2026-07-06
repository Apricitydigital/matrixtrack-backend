const {
  ensureProfessionalPushSchema,
  registerProfessionalPushToken,
  unregisterProfessionalPushToken,
} = require("../utils/professionalPushService");

const registerPushToken = async (req, res) => {
  const professionalId = req.professional?.professional_id;
  const token = String(req.body?.token || "").trim();
  const platform = String(req.body?.platform || "").trim().toLowerCase();

  if (!professionalId) {
    return res.status(401).json({ success: false, message: "Unauthorized professional session." });
  }
  if (!token) {
    return res.status(400).json({ success: false, message: "Push token is required." });
  }

  try {
    await ensureProfessionalPushSchema();
    await registerProfessionalPushToken({
      professionalId,
      expoPushToken: token,
      platform: platform || null,
    });
    return res.json({ success: true, message: "Push token registered." });
  } catch (error) {
    console.error("[ProfessionalPush] registerPushToken error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to register push token." });
  }
};

const unregisterPushToken = async (req, res) => {
  const professionalId = req.professional?.professional_id;
  const token = String(req.body?.token || "").trim();

  if (!professionalId) {
    return res.status(401).json({ success: false, message: "Unauthorized professional session." });
  }
  if (!token) {
    return res.status(400).json({ success: false, message: "Push token is required." });
  }

  try {
    await ensureProfessionalPushSchema();
    await unregisterProfessionalPushToken({
      professionalId,
      expoPushToken: token,
    });
    return res.json({ success: true, message: "Push token unregistered." });
  } catch (error) {
    console.error("[ProfessionalPush] unregisterPushToken error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to unregister push token." });
  }
};

module.exports = {
  registerPushToken,
  unregisterPushToken,
};
