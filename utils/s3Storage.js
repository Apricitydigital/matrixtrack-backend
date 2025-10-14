const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
require("dotenv").config();

const {
  s3,
  PutObjectCommand,
  GetObjectCommand,
} = require("../config/awsConfig");

const AWS_S3_BUCKET
  = process.env.AWS_S3_BUCKET
  || process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;
const ATTENDANCE_PREFIX = process.env.S3_ATTENDANCE_PREFIX || "attendance";
const S3_BASE_URL =
  AWS_S3_BUCKET && AWS_REGION
    ? `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/`
    : AWS_S3_BUCKET
      ? `https://${AWS_S3_BUCKET}.s3.amazonaws.com/`
      : null;

function ensureLocalDirectory() {
  const uploadsRoot = path.join(__dirname, "..", "uploads");
  const attendanceDir = path.join(uploadsRoot, "attendance");
  if (!fs.existsSync(attendanceDir)) {
    fs.mkdirSync(attendanceDir, { recursive: true });
  }
  return attendanceDir;
}

async function uploadImageLocally(imageBuffer, fileName) {
  const attendanceDir = ensureLocalDirectory();
  const filePath = path.join(attendanceDir, fileName);
  await fs.promises.writeFile(filePath, imageBuffer);
  return {
    storage: "local",
    key: null,
    url: `/uploads/attendance/${fileName}`,
  };
}

function buildAttendanceKey(fileName) {
  return `${ATTENDANCE_PREFIX}/${fileName}`;
}

async function uploadAttendanceImage(imageBuffer, fileName) {
  if (!AWS_S3_BUCKET
  ) {
    return uploadImageLocally(imageBuffer, fileName);
  }

  const key = buildAttendanceKey(fileName);
  const putParams = {
    Bucket: AWS_S3_BUCKET
    ,
    Key: key,
    Body: imageBuffer,
    ContentType: "image/jpeg",
  };

  try {
    await s3.send(new PutObjectCommand({ ...putParams, ACL: "public-read" }));
  } catch (error) {
    if (
      error?.name === "AccessControlListNotSupported" ||
      error?.Code === "AccessControlListNotSupported"
    ) {
      await s3.send(new PutObjectCommand(putParams));
    } else {
      console.error("S3 upload failed:", error?.message || error);
      return uploadImageLocally(imageBuffer, fileName);
    }
  }

  const url = S3_BASE_URL ? `${S3_BASE_URL}${key}` : key;

  return {
    storage: "s3",
    key,
    url,
  };
}

function isLocalImage(imageUrl) {
  return Boolean(imageUrl?.startsWith("/uploads/"));
}

function getLocalImagePath(imageUrl) {
  const relativePath = imageUrl.replace(/^\//, "");
  return path.join(__dirname, "..", relativePath);
}

function isS3Image(imageUrl) {
  if (!AWS_S3_BUCKET || !imageUrl) {
    return false;
  }

  if (imageUrl.startsWith("https://")) {
    if (S3_BASE_URL && imageUrl.startsWith(S3_BASE_URL)) {
      return true;
    }

    return imageUrl.includes(`${AWS_S3_BUCKET}.s3.`);
  }

  return imageUrl.startsWith(`${ATTENDANCE_PREFIX}/`);
}

function extractS3Key(imageUrl) {
  if (!imageUrl) {
    return null;
  }

  try {
    const url = new URL(imageUrl);
    return decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch (_error) {
    if (imageUrl.startsWith(`${ATTENDANCE_PREFIX}/`)) {
      return imageUrl;
    }
    return null;
  }
}

async function getS3ImageStream(key) {
  if (!AWS_S3_BUCKET
  ) {
    throw new Error("AWS S3 bucket is not configured");
  }

  const command = new GetObjectCommand({
    Bucket: AWS_S3_BUCKET
    , Key: key
  });
  const response = await s3.send(command);
  const body = response.Body;
  const stream =
    typeof body?.pipe === "function" ? body : Readable.from(body ?? []);

  return {
    stream,
    contentType: response.ContentType || "image/jpeg",
  };
}

module.exports = {
  uploadAttendanceImage,
  isLocalImage,
  getLocalImagePath,
  isS3Image,
  extractS3Key,
  getS3ImageStream,
};
