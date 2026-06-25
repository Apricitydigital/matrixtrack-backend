// utils/s3Logger.js
const { s3, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("../config/awsConfig");
const { HeadBucketCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "../logs/audit");
let bucketAvailability = "unknown";

const sanitizeKeyPart = (value, fallback = "unknown") => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
};

const getEnvironmentScope = () => {
  const dbHost = String(process.env.DB_HOST || "unknown-host").trim();
  const dbName = String(process.env.DB_NAME || "unknown-db").trim();
  const scopeKey = sanitizeKeyPart(dbHost);

  return {
    dbHost,
    dbName,
    scopeKey,
  };
};

async function ensureBucketAccessible(bucketName) {
  if (bucketAvailability === "available") return true;
  if (bucketAvailability === "unavailable") return false;

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    bucketAvailability = "available";
    return true;
  } catch (error) {
    bucketAvailability = "unavailable";
    console.warn(
      `[S3Logger] S3 audit bucket ${bucketName} is unavailable (${error.name || "UnknownError"}). Falling back to local logging.`
    );
    return false;
  }
}

const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

async function uploadAuditLog(logObject) {
  const bucketName = process.env.AWS_LOGS_S3_BUCKET || "matrixtrack-audit-logs";
  const dateStr = logObject.timestamp.slice(0, 10);
  const envScope = getEnvironmentScope();
  const filename = `${new Date(logObject.timestamp).getTime()}-${logObject.actor?.user_id || "guest"}.json`;
  const s3Key = `audit-logs/${envScope.scopeKey}/${dateStr}/${filename}`;
  const logPayload = {
    ...logObject,
    environment: {
      db_host: envScope.dbHost,
      db_name: envScope.dbName,
      scope_key: envScope.scopeKey,
    },
  };
  const logString = JSON.stringify(logPayload, null, 2);

  if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const bucketReady = await ensureBucketAccessible(bucketName);
      if (bucketReady) {
        await s3.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          Body: logString,
          ContentType: "application/json"
        }));
        console.log(`[S3Logger] Uploaded audit log to S3: ${s3Key}`);
        return;
      }
    } catch (s3Error) {
      console.error(`[S3Logger] S3 upload failed (falling back to local file):`, s3Error.message);
    }
  } else {
    console.warn(`[S3Logger] AWS credentials not fully set up. Falling back to local logging.`);
  }

  try {
    const dailyDir = path.join(LOGS_DIR, envScope.scopeKey, dateStr);
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
    }
    const localFilePath = path.join(dailyDir, filename);
    fs.writeFileSync(localFilePath, logString, "utf8");
    console.log(`[S3Logger] Wrote audit log to local file: ${localFilePath}`);
  } catch (localError) {
    console.error(`[S3Logger] Local logging fallback failed:`, localError.message);
  }
}

async function fetchAuditLogsForDate(dateString) {
  const bucketName = process.env.AWS_LOGS_S3_BUCKET || "matrixtrack-audit-logs";
  const envScope = getEnvironmentScope();
  const prefix = `audit-logs/${envScope.scopeKey}/${dateString}/`;
  const parsedLogs = [];

  if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const bucketReady = await ensureBucketAccessible(bucketName);
      if (!bucketReady) {
        return parsedLogs;
      }

      const listData = await s3.send(new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix
      }));

      const contents = listData.Contents || [];
      if (contents.length > 0) {
        const fetchPromises = contents.map(async (obj) => {
          try {
            const data = await s3.send(new GetObjectCommand({
              Bucket: bucketName,
              Key: obj.Key
            }));
            const jsonString = await streamToString(data.Body);
            const parsed = JSON.parse(jsonString);
            const parsedScope = parsed?.environment?.scope_key;
            if (parsedScope && parsedScope !== envScope.scopeKey) {
              return null;
            }
            return parsed;
          } catch (fetchError) {
            console.error(`[S3Logger] Failed to fetch log object ${obj.Key}:`, fetchError.message);
            return null;
          }
        });

        const results = await Promise.all(fetchPromises);
        results.forEach((log) => {
          if (log) parsedLogs.push(log);
        });

        return parsedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      }
    } catch (s3Error) {
      console.error(`[S3Logger] S3 log fetch failed:`, s3Error.message);
    }
  }

  try {
    const dailyDir = path.join(LOGS_DIR, envScope.scopeKey, dateString);
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = fs.readFileSync(path.join(dailyDir, file), "utf8");
        try {
          const parsed = JSON.parse(content);
          const parsedScope = parsed?.environment?.scope_key;
          if (!parsedScope || parsedScope === envScope.scopeKey) {
            parsedLogs.push(parsed);
          }
        } catch (e) {
        }
      }
      return parsedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
  } catch (localError) {
    console.error(`[S3Logger] Local log fetch failed:`, localError.message);
  }

  return [];
}

module.exports = {
  fetchAuditLogsForDate,
  getEnvironmentScope,
  uploadAuditLog,
};
