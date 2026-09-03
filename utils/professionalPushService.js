const axios = require("axios");
const {
  SNSClient,
  CreatePlatformEndpointCommand,
  GetEndpointAttributesCommand,
  SetEndpointAttributesCommand,
  PublishCommand,
} = require("@aws-sdk/client-sns");
const pool = require("../config/db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_PREFIXES = ["ExponentPushToken[", "ExpoPushToken["];
const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};
const SNS_PUSH_CONCURRENCY = boundedInteger(
  process.env.PROFESSIONAL_PUSH_SNS_CONCURRENCY,
  20,
  1,
  50
);
const EXPO_PUSH_CONCURRENCY = boundedInteger(
  process.env.PROFESSIONAL_PUSH_EXPO_CONCURRENCY,
  3,
  1,
  10
);
const snsClient = new SNSClient({
  region: process.env.AWS_REGION || "ap-south-1",
  maxAttempts: boundedInteger(process.env.PROFESSIONAL_PUSH_AWS_MAX_ATTEMPTS, 3, 1, 5),
  credentials:
    process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

const isExpoPushToken = (token = "") =>
  EXPO_TOKEN_PREFIXES.some((prefix) => String(token).startsWith(prefix));

const resolvePlatformApplicationArn = (provider = "", platform = "") => {
  const normalizedProvider = String(provider || "").toLowerCase();
  const normalizedPlatform = String(platform || "").toLowerCase();

  if (normalizedProvider === "fcm" || normalizedPlatform === "android") {
    return process.env.AWS_SNS_FCM_PLATFORM_APPLICATION_ARN || null;
  }
  if (normalizedProvider === "apns_sandbox") {
    return process.env.AWS_SNS_APNS_SANDBOX_PLATFORM_APPLICATION_ARN || null;
  }
  if (normalizedProvider === "apns" || normalizedPlatform === "ios") {
    return (
      process.env.AWS_SNS_APNS_PLATFORM_APPLICATION_ARN ||
      process.env.AWS_SNS_APNS_SANDBOX_PLATFORM_APPLICATION_ARN ||
      null
    );
  }
  return null;
};

const normalizePushProvider = (provider = "", platform = "", token = "") => {
  if (isExpoPushToken(token)) return "expo";
  const normalizedProvider = String(provider || "").toLowerCase();
  const normalizedPlatform = String(platform || "").toLowerCase();

  if (normalizedProvider === "fcm" || normalizedProvider === "apns" || normalizedProvider === "apns_sandbox") {
    return normalizedProvider;
  }
  if (normalizedPlatform === "android") return "fcm";
  if (normalizedPlatform === "ios") return "apns";
  return "unknown";
};

const ensureSnsPlatformEndpoint = async ({
  deviceToken,
  provider,
  platform,
  existingEndpointArn,
  customUserData,
}) => {
  const platformApplicationArn = resolvePlatformApplicationArn(provider, platform);
  if (!platformApplicationArn) {
    throw new Error(`Missing SNS platform application ARN for provider "${provider}" and platform "${platform}".`);
  }

  const tokenString = String(deviceToken || "").trim();
  if (!tokenString) {
    throw new Error("Device token is required for SNS mobile push registration.");
  }

  let endpointArn = String(existingEndpointArn || "").trim() || null;

  if (!endpointArn) {
    const createResponse = await snsClient.send(
      new CreatePlatformEndpointCommand({
        PlatformApplicationArn: platformApplicationArn,
        Token: tokenString,
        CustomUserData: customUserData || undefined,
      })
    );
    endpointArn = createResponse?.EndpointArn || null;
  }

  if (!endpointArn) {
    throw new Error("SNS platform endpoint ARN was not returned.");
  }

  try {
    const attributesResponse = await snsClient.send(
      new GetEndpointAttributesCommand({
        EndpointArn: endpointArn,
      })
    );
    const attributes = attributesResponse?.Attributes || {};
    const currentToken = String(attributes.Token || "");
    const enabled = String(attributes.Enabled || "").toLowerCase() === "true";

    if (currentToken !== tokenString || !enabled) {
      await snsClient.send(
        new SetEndpointAttributesCommand({
          EndpointArn: endpointArn,
          Attributes: {
            Token: tokenString,
            Enabled: "true",
          },
        })
      );
    }
  } catch (error) {
    const createResponse = await snsClient.send(
      new CreatePlatformEndpointCommand({
        PlatformApplicationArn: platformApplicationArn,
        Token: tokenString,
        CustomUserData: customUserData || undefined,
      })
    );
    endpointArn = createResponse?.EndpointArn || endpointArn;
  }

  return endpointArn;
};

const buildSnsPublishPayload = (item, provider = "fcm") => {
  const title = item.title || "Notification";
  const body = item.message || "You have a new update.";
  const data = {
    type: item.type || "general",
    notification_id: item.id || "",
    professional_id: String(item.professional_id || ""),
    metadata: item.metadata || {},
  };

  if (provider === "apns" || provider === "apns_sandbox") {
    const apnsMessage = JSON.stringify({
      aps: {
        alert: { title, body },
        sound: "default",
      },
      data,
    });
    return {
      MessageStructure: "json",
      Message: JSON.stringify({
        default: body,
        [provider === "apns_sandbox" ? "APNS_SANDBOX" : "APNS"]: apnsMessage,
      }),
    };
  }

  const gcmMessage = JSON.stringify({
    notification: {
      title,
      body,
      sound: "default",
    },
    data,
    priority: "high",
  });
  return {
    MessageStructure: "json",
    Message: JSON.stringify({
      default: body,
      GCM: gcmMessage,
    }),
  };
};

const chunkArray = (items = [], size = 100) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const runWithConcurrency = async (items, concurrency, worker) => {
  if (!Array.isArray(items) || items.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
};

const applyProfessionalPushSchema = async (clientRef) => {
  await clientRef.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await clientRef.query(`
    CREATE TABLE IF NOT EXISTS professional_push_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      professional_id UUID NOT NULL REFERENCES professional_employees(id) ON DELETE CASCADE,
      expo_push_token VARCHAR(255) NOT NULL UNIQUE,
      push_provider VARCHAR(24) DEFAULT 'expo',
      platform_endpoint_arn TEXT,
      platform VARCHAR(16),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await clientRef.query(`
    ALTER TABLE professional_push_tokens
    ADD COLUMN IF NOT EXISTS push_provider VARCHAR(24) DEFAULT 'expo'
  `);
  await clientRef.query(`
    ALTER TABLE professional_push_tokens
    ADD COLUMN IF NOT EXISTS platform_endpoint_arn TEXT
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

let pushSchemaPromise = null;
const ensureProfessionalPushSchema = (clientRef = pool) => {
  // Migration transactions pass their own client and must execute on that client.
  if (clientRef !== pool) return applyProfessionalPushSchema(clientRef);

  if (!pushSchemaPromise) {
    pushSchemaPromise = applyProfessionalPushSchema(pool).catch((error) => {
      pushSchemaPromise = null;
      throw error;
    });
  }
  return pushSchemaPromise;
};

const registerProfessionalPushToken = async ({
  professionalId,
  expoPushToken,
  provider,
  platform,
  existingEndpointArn,
}) => {
  if (!professionalId || !expoPushToken) return false;

  await ensureProfessionalPushSchema();
  const pushProvider = normalizePushProvider(provider, platform, expoPushToken);
  let endpointArn = null;

  if (pushProvider !== "expo") {
    endpointArn = await ensureSnsPlatformEndpoint({
      deviceToken: expoPushToken,
      provider: pushProvider,
      platform,
      existingEndpointArn,
      customUserData: String(professionalId),
    });
  }

  await pool.query(
    `INSERT INTO professional_push_tokens (
       professional_id, expo_push_token, push_provider, platform_endpoint_arn, platform, is_active, updated_at, last_seen_at
     )
     VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
     ON CONFLICT (expo_push_token)
     DO UPDATE
       SET professional_id = EXCLUDED.professional_id,
           push_provider = EXCLUDED.push_provider,
           platform_endpoint_arn = EXCLUDED.platform_endpoint_arn,
           platform = EXCLUDED.platform,
           is_active = TRUE,
           updated_at = NOW(),
           last_seen_at = NOW()`,
    [professionalId, expoPushToken, pushProvider, endpointArn, platform || null]
  );
  return { ok: true, provider: pushProvider, endpointArn };
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
    return { sent: 0, failed: 0, invalidated: 0, noDestination: 0 };
  }

  await ensureProfessionalPushSchema();
  const professionalIds = Array.from(
    new Set(notifications.map((n) => n.professional_id).filter(Boolean))
  );
  if (professionalIds.length === 0) {
    return { sent: 0, failed: 0, invalidated: 0, noDestination: 0 };
  }

  const tokenRows = await pool.query(
    `SELECT professional_id, expo_push_token, push_provider, platform_endpoint_arn, platform
     FROM professional_push_tokens
     WHERE professional_id = ANY($1::uuid[]) AND is_active = TRUE`,
    [professionalIds]
  );

  if (tokenRows.rows.length === 0) {
    return { sent: 0, failed: 0, invalidated: 0, noDestination: professionalIds.length };
  }

  const tokenMap = new Map();
  tokenRows.rows.forEach((row) => {
    const key = String(row.professional_id);
    if (!tokenMap.has(key)) tokenMap.set(key, []);
    tokenMap.get(key).push(row);
  });
  const messages = [];
  const snsMessages = [];
  const professionalsWithDestination = new Set();
  notifications.forEach((item) => {
    const tokens = tokenMap.get(String(item.professional_id)) || [];
    tokens.forEach((tokenRow) => {
      const provider = String(tokenRow.push_provider || "").toLowerCase();
      if (provider === "expo" && isExpoPushToken(tokenRow.expo_push_token)) {
        messages.push({
          to: tokenRow.expo_push_token,
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
        professionalsWithDestination.add(String(item.professional_id));
        return;
      }

      if (tokenRow.platform_endpoint_arn) {
        snsMessages.push({
          endpointArn: tokenRow.platform_endpoint_arn,
          provider: provider || normalizePushProvider("", tokenRow.platform, tokenRow.expo_push_token),
          item,
        });
        professionalsWithDestination.add(String(item.professional_id));
      }
    });
  });
  const noDestination = professionalIds.reduce(
    (count, professionalId) =>
      count + (professionalsWithDestination.has(String(professionalId)) ? 0 : 1),
    0
  );

  const invalidTokens = new Set();
  let sent = 0;
  let failed = 0;
  let snsFailed = 0;
  const invalidEndpoints = new Set();
  const snsErrorSamples = [];

  if (messages.length > 0) {
    const chunks = chunkArray(messages, 100);

    await runWithConcurrency(chunks, EXPO_PUSH_CONCURRENCY, async (chunk) => {
      try {
        const response = await axios.post(EXPO_PUSH_URL, chunk, {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeout: 12000,
        });
        const tickets = Array.isArray(response?.data?.data) ? response.data.data : [];
        chunk.forEach((message, index) => {
          const ticket = tickets[index];
          if (ticket?.status === "ok") {
            sent += 1;
            return;
          }
          failed += 1;
          if (ticket?.details?.error === "DeviceNotRegistered") {
            invalidTokens.add(message?.to);
          }
        });
      } catch (error) {
        failed += chunk.length;
        console.warn("[PushService] Expo push send failed:", error.message);
      }
    });
  }

  await runWithConcurrency(snsMessages, SNS_PUSH_CONCURRENCY, async (snsMessage) => {
    try {
      const payload = buildSnsPublishPayload(snsMessage.item, snsMessage.provider);
      await snsClient.send(
        new PublishCommand({
          TargetArn: snsMessage.endpointArn,
          ...payload,
        })
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      snsFailed += 1;
      const errorCode = String(error?.name || error?.code || "");
      if (errorCode.includes("EndpointDisabled")) {
        invalidEndpoints.add(snsMessage.endpointArn);
      }
      if (snsErrorSamples.length < 5) {
        snsErrorSamples.push(`${errorCode || "Error"}: ${error.message}`);
      }
    }
  });

  if (snsErrorSamples.length > 0) {
    console.warn(
      `[PushService] SNS failures: ${snsFailed}; sample(s): ${snsErrorSamples.join(" | ")}`
    );
  }

  if (invalidTokens.size > 0) {
    await pool.query(
      `UPDATE professional_push_tokens
       SET is_active = FALSE, updated_at = NOW()
       WHERE expo_push_token = ANY($1::text[])`,
      [Array.from(invalidTokens)]
    );
  }

  if (invalidEndpoints.size > 0) {
    await pool.query(
      `UPDATE professional_push_tokens
       SET is_active = FALSE, updated_at = NOW()
       WHERE platform_endpoint_arn = ANY($1::text[])`,
      [Array.from(invalidEndpoints)]
    );
  }

  return {
    sent,
    failed,
    invalidated: invalidTokens.size + invalidEndpoints.size,
    noDestination,
  };
};

module.exports = {
  ensureProfessionalPushSchema,
  registerProfessionalPushToken,
  unregisterProfessionalPushToken,
  sendPushToProfessionals,
};
