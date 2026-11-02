const {
  ensureSelfAttendancePushSchema,
  registerSelfAttendancePushToken,
  unregisterSelfAttendancePushToken,
} = require("../utils/selfAttendancePushService");

const registerPushToken = async (req, res) => {
  const selfAttendanceId = req.self_attendance?.self_attendance_id;
  const token = String(req.body?.token || "").trim();
  const platform = String(req.body?.platform || "").trim().toLowerCase();
  const provider = String(req.body?.provider || "").trim().toLowerCase();
  const endpointArn = String(req.body?.endpoint_arn || "").trim() || null;

  if (!selfAttendanceId) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }
  if (!token) {
    return res.status(400).json({ success: false, message: "Push token is required." });
  }

  try {
    await ensureSelfAttendancePushSchema();
    const result = await registerSelfAttendancePushToken({
      selfAttendanceId,
      expoPushToken: token,
      provider: provider || null,
      platform: platform || null,
      existingEndpointArn: endpointArn,
    });
    return res.json({ success: true, message: "Push token registered.", data: result });
  } catch (error) {
    console.error("[SelfAttendancePush] registerPushToken error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to register push token." });
  }
};

const unregisterPushToken = async (req, res) => {
  const selfAttendanceId = req.self_attendance?.self_attendance_id;
  const token = String(req.body?.token || "").trim();

  if (!selfAttendanceId) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }
  if (!token) {
    return res.status(400).json({ success: false, message: "Push token is required." });
  }

  try {
    await ensureSelfAttendancePushSchema();
    await unregisterSelfAttendancePushToken({
      selfAttendanceId,
      expoPushToken: token,
    });
    return res.json({ success: true, message: "Push token unregistered." });
  } catch (error) {
    console.error("[SelfAttendancePush] unregisterPushToken error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to unregister push token." });
  }
};

module.exports = {
  registerPushToken,
  unregisterPushToken,
};
