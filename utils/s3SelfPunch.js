const {
  s3,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} = require('../config/awsConfig');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;
const S3_BASE_URL = AWS_S3_BUCKET && AWS_REGION 
  ? `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/` 
  : AWS_S3_BUCKET ? `https://${AWS_S3_BUCKET}.s3.amazonaws.com/` : null;

/**
 * Uploads a file buffer directly to S3.
 * @param {Buffer} fileBuffer - The file buffer from multer.
 * @param {string} key - The S3 object key (path).
 * @param {string} mimeType - The mime type of the file.
 * @returns {Promise<string>} - The S3 Object key.
 */
async function uploadToS3(fileBuffer, key, mimeType) {
  if (!AWS_S3_BUCKET) {
    throw new Error("AWS S3 bucket is not configured. Cannot process self-punch request.");
  }

  const putParams = {
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType,
  };

  try {
    // Attempt with public-read ACL first
    await s3.send(new PutObjectCommand({ ...putParams, ACL: "public-read" }));
  } catch (error) {
    if (error?.name === "AccessControlListNotSupported" || error?.Code === "AccessControlListNotSupported") {
      // Fallback if bucket doesn't support ACLs
      await s3.send(new PutObjectCommand(putParams));
    } else {
      throw error;
    }
  }

  return key; // We store the KEY in the DB, not the full URL.
}

/**
 * Deletes an object from S3.
 * @param {string} key - The S3 object key.
 */
async function deleteFromS3(key) {
  if (!AWS_S3_BUCKET || !key) return;

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key
    }));
  } catch (error) {
    console.error(`[S3] Failed to delete object ${key} during rollback:`, error.message);
  }
}

/**
 * Generates a signed URL for an S3 object.
 * @param {string} key - The S3 object key.
 * @param {number} expiresIn - Expiry time in seconds (default 900s = 15m)
 * @returns {Promise<string|null>} - The signed URL or null if failed.
 */
async function getSignedS3Url(key, expiresIn = 900) {
  if (!AWS_S3_BUCKET || !key) return null;

  try {
    const command = new GetObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key
    });
    // Generate a signed URL that expires in `expiresIn` seconds
    return await getSignedUrl(s3, command, { expiresIn });
  } catch (error) {
    console.error(`[S3] Failed to generate signed URL for ${key}:`, error.message);
    return null;
  }
}

module.exports = {
  uploadToS3,
  deleteFromS3,
  getSignedS3Url
};
