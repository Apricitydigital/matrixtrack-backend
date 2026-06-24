// utils/s3Logger.js
const { s3, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("../config/awsConfig");
const { CreateBucketCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");

const LOGS_DIR = path.join(__dirname, "../logs/audit");
let bucketChecked = false;

// Helper to check and create S3 bucket if it doesn't exist
async function ensureBucketExists(bucketName) {
  if (bucketChecked) return true;
  try {
    // Check if bucket exists
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    bucketChecked = true;
    return true;
  } catch (error) {
    // If bucket doesn't exist (404), attempt to create it
    if (error.name === "NotFound" || error.$metadata?.status === 404) {
      console.log(`[S3Logger] Bucket ${bucketName} not found. Attempting to create it...`);
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
        console.log(`[S3Logger] ✅ Successfully created bucket: ${bucketName}`);
        bucketChecked = true;
        return true;
      } catch (createError) {
        console.error(`[S3Logger] ❌ Failed to create bucket ${bucketName}:`, createError.message);
        throw createError;
      }
    }
    console.error(`[S3Logger] ❌ Error checking bucket ${bucketName}:`, error.message);
    throw error;
  }
}

// Helper to convert readable stream to string (S3 SDK v3 helper)
const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

/**
 * Uploads a log entry to AWS S3, falling back to a local file on failure.
 * Runs asynchronously and does not block the response.
 */
async function uploadAuditLog(logObject) {
  const bucketName = process.env.AWS_LOGS_S3_BUCKET || "matrixtrack-audit-logs";
  const dateStr = logObject.timestamp.slice(0, 10); // YYYY-MM-DD
  const filename = `${new Date(logObject.timestamp).getTime()}-${logObject.actor?.user_id || "guest"}.json`;
  const s3Key = `audit-logs/${dateStr}/${filename}`;
  const logString = JSON.stringify(logObject, null, 2);

  // 1. Try S3 Upload (if configured)
  if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      await ensureBucketExists(bucketName);
      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: logString,
        ContentType: "application/json"
      }));
      console.log(`[S3Logger] ✅ Uploaded audit log to S3: ${s3Key}`);
      return;
    } catch (s3Error) {
      console.error(`[S3Logger] ❌ S3 upload failed (falling back to local file):`, s3Error.message);
    }
  } else {
    console.warn(`[S3Logger] ⚠️ AWS credentials not fully set up. Falling back to local logging.`);
  }

  // 2. Fallback to Local Directory
  try {
    const dailyDir = path.join(LOGS_DIR, dateStr);
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
    }
    const localFilePath = path.join(dailyDir, filename);
    fs.writeFileSync(localFilePath, logString, "utf8");
    console.log(`[S3Logger] ✅ Wrote audit log to local file: ${localFilePath}`);
  } catch (localError) {
    console.error(`[S3Logger] ❌ Local logging fallback failed:`, localError.message);
  }
}

/**
 * Fetches all parsed log entries for a given date (YYYY-MM-DD).
 * Fetches from S3 first, otherwise checks the local directory fallback.
 */
async function fetchAuditLogsForDate(dateString) {
  const bucketName = process.env.AWS_LOGS_S3_BUCKET || "matrixtrack-audit-logs";
  const prefix = `audit-logs/${dateString}/`;
  const parsedLogs = [];

  // 1. Fetch from S3 (if credentials are set up)
  if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      await ensureBucketExists(bucketName);
      const listData = await s3.send(new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix
      }));

      const contents = listData.Contents || [];
      if (contents.length > 0) {
        // Concurrently fetch all objects under this prefix
        const fetchPromises = contents.map(async (obj) => {
          try {
            const data = await s3.send(new GetObjectCommand({
              Bucket: bucketName,
              Key: obj.Key
            }));
            const jsonString = await streamToString(data.Body);
            return JSON.parse(jsonString);
          } catch (fetchError) {
            console.error(`[S3Logger] Failed to fetch log object ${obj.Key}:`, fetchError.message);
            return null;
          }
        });

        const results = await Promise.all(fetchPromises);
        results.forEach(log => {
          if (log) parsedLogs.push(log);
        });

        // Sort descending by timestamp
        return parsedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      }
    } catch (s3Error) {
      console.error(`[S3Logger] S3 log fetch failed:`, s3Error.message);
      // Fallback to local search if S3 query fails
    }
  }

  // 2. Fetch from Local Fallback
  try {
    const dailyDir = path.join(LOGS_DIR, dateString);
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const content = fs.readFileSync(path.join(dailyDir, file), "utf8");
          try {
            parsedLogs.push(JSON.parse(content));
          } catch (e) {
            // skip malformed logs
          }
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
  uploadAuditLog,
  fetchAuditLogsForDate
};
