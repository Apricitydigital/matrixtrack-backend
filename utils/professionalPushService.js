const axios = require("axios");
const pool = require("../config/db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_PREFIXES = ["ExponentPushToken[", "ExpoPushToken["];

const isExpoPushToken = (token = "") =>
  EXPO_TOKEN_PREFIXES.some((prefix) => String(token).startsWith(prefix));

const chunkArray = (items = [], size = 100) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const ensureProfessionalPushSchema = async (clientRef = pool) => {
  await clientRef.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await clientRef.query(`
    CREATE TABLE IF NOT EXISTS professional_push_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
      expo_push_token VARCHAR(255) NOT NULL UNIQUE,
      platform VARCHAR(16),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await clientRef.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uidx_prof_push_prof_token
    ON professional_push_tokens (professional_id, expo_push_token)
  `);
  await clientRef.query(`
    CREATE INDEX IF NOT EXISTS idx_prof_push_prof_active
    ON professional_push_tokens (professional_id, is_active, updated_at DESC)
  `);
};

const registerProfessionalPushToken = async ({
  professionalId,
  expoPushToken,
  platform,
}) => {
  if (!professionalId || !isExpoPushToken(expoPushToken)) return false;

  await ensureProfessionalPushSchema();
  await pool.query(
    `INSERT INTO professional_push_tokens (
       professional_id, expo_push_token, platform, is_active, updated_at, last_seen_at
     )
     VALUES ($1, $2, $3, TRUE, NOW(), NOW())
     ON CONFLICT (expo_push_token)
     DO UPDATE
       SET professional_id = EXCLUDED.professional_id,
           platform = EXCLUDED.platform,
           is_active = TRUE,
           updated_at = NOW(),
           last_seen_at = NOW()`,
    [professionalId, expoPushToken, platform || null]
  );
  return true;
};

const unregisterProfessionalPushToken = async ({ professionalId, expoPushToken }) => {
  if (!professionalId || !expoPushToken) return false;
  await ensureProfessionalPushSchema();
  await pool.query(
    `UPDATE professional_push_tokens
     SET is_active = FALSE, updated_at = NOW()
     WHERE professional_id = $1 AND expo_push_token = $2`,
    [professionalId, expoPushToken]
  );
  return true;
};

const sendPushToProfessionals = async (notifications = []) => {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return { sent: 0, failed: 0, invalidated: 0 };
  }

  await ensureProfessionalPushSchema();
  const professionalIds = Array.from(
    new Set(notifications.map((n) => n.professional_id).filter(Boolean))
  );
  if (professionalIds.length === 0) {
    return { sent: 0, failed: 0, invalidated: 0 };
  }

  const tokenRows = await pool.query(
    `SELECT professional_id, expo_push_token
     FROM professional_push_tokens
     WHERE professional_id = ANY($1::uuid[]) AND is_active = TRUE`,
    [professionalIds]
  );

  if (tokenRows.rows.length === 0) {
    return { sent: 0, failed: 0, invalidated: 0 };
  }

  const tokenMap = new Map();
  tokenRows.rows.forEach((row) => {
    const key = String(row.professional_id);
    if (!tokenMap.has(key)) tokenMap.set(key, []);
    tokenMap.get(key).push(row.expo_push_token);
  });

  const messages = [];
  notifications.forEach((item) => {
    const tokens = tokenMap.get(String(item.professional_id)) || [];
    tokens.forEach((to) => {
      if (!isExpoPushToken(to)) return;
      messages.push({
        to,
        sound: "default",
        title: item.title || "Notification",
        body: item.message || "You have a new update.",
        data: {
          type: item.type || "general",
          notification_id: item.id || null,
          professional_id: item.professional_id,
          metadata: item.metadata || {},
        },
        priority: "high",
        channelId: "default",
      });
    });
  });

  if (messages.length === 0) {
    return { sent: 0, failed: 0, invalidated: 0 };
  }

  const invalidTokens = new Set();
  let sent = 0;
  let failed = 0;
  const chunks = chunkArray(messages, 100);

  for (const chunk of chunks) {
    try {
      const response = await axios.post(EXPO_PUSH_URL, chunk, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 12000,
      });
      const tickets = Array.isArray(response?.data?.data) ? response.data.data : [];
      tickets.forEach((ticket, index) => {
        if (ticket?.status === "ok") {
          sent += 1;
          return;
        }
        failed += 1;
        if (ticket?.details?.error === "DeviceNotRegistered") {
          invalidTokens.add(chunk[index]?.to);
        }
      });
    } catch (error) {
      failed += chunk.length;
      console.warn("[PushService] Expo push send failed:", error.message);
    }
  }

  if (invalidTokens.size > 0) {
    await pool.query(
      `UPDATE professional_push_tokens
       SET is_active = FALSE, updated_at = NOW()
       WHERE expo_push_token = ANY($1::text[])`,
      [Array.from(invalidTokens)]
    );
  }

  return { sent, failed, invalidated: invalidTokens.size };
};

module.exports = {
  ensureProfessionalPushSchema,
  registerProfessionalPushToken,
  unregisterProfessionalPushToken,
  sendPushToProfessionals,
};
