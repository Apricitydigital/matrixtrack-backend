const {
  rekognition,
  CompareFacesCommand,
  s3,
  GetObjectCommand
} = require('../config/awsConfig');
const axios = require('axios');
const logger = require('./logger');
const { sendTrackedRekognition, getIstDateKey } = require('./cityTrafficCost');

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Compares a live selfie (base64) against an existing S3 object.
 * @param {string} sourceS3Key - The S3 object key of the stored face
 * @param {string} targetBase64 - The live base64 string
 * @param {number} threshold - Minimum similarity threshold (0-100)
 * @returns {Promise<{ isMatch: boolean, confidence: number }>}
 */
async function verifyFaceMatch(sourceS3Key, targetBase64, threshold = 80, tracking = {}) {
  if (!AWS_S3_BUCKET) {
    logger.warn('[FaceService] AWS S3 bucket not configured. Bypassing face match (dev mode only).');
    // If not configured, we might reject or allow depending on environment.
    // For safety, we reject in production.
    return { isMatch: false, confidence: 0 };
  }

  try {
    let sourceImageBuffer = null;
    let normalizedSourceKey = String(sourceS3Key || '').trim();

    // 1. If it's a full URL (S3, Backblaze, etc.), try downloading directly via HTTP
    if (normalizedSourceKey.startsWith('http://') || normalizedSourceKey.startsWith('https://')) {
      try {
        const resp = await axios.get(normalizedSourceKey, { responseType: 'arraybuffer' });
        sourceImageBuffer = Buffer.from(resp.data);
      } catch (err) {
        // Fallback: extract the key from the URL and try S3 directly
        try {
          const parsedUrl = new URL(normalizedSourceKey);
          normalizedSourceKey = decodeURIComponent(parsedUrl.pathname || '').replace(/^\/+/, '');
        } catch (_) {
          normalizedSourceKey = normalizedSourceKey.replace(/^https?:\/\/[^/]+\//i, '');
        }
      }
    }

    // 2. If HTTP download failed or it's just a raw key, fetch from S3
    if (!sourceImageBuffer && normalizedSourceKey) {
       const buckets = [...new Set([
         AWS_S3_BUCKET, 
         process.env.SECONDARY_S3_BUCKET, 
         "attend-ease-images", 
         "dailyfacerecord"
       ].filter(Boolean))];
       
       for (const bucket of buckets) {
         try {
           const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: normalizedSourceKey }));
           sourceImageBuffer = await streamToBuffer(resp.Body);
           break;
         } catch(e) {}
       }
    }

    if (!sourceImageBuffer) {
      throw new Error('Unable to download reference selfie from storage.');
    }

    // Strip base64 metadata if present (e.g., "data:image/jpeg;base64,")
    const base64Data = targetBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const compareCommand = new CompareFacesCommand({
      SourceImage: { Bytes: sourceImageBuffer },
      TargetImage: { Bytes: imageBuffer },
      SimilarityThreshold: threshold
    });

    const response = await sendTrackedRekognition({
      client: rekognition,
      command: compareCommand,
      cityId: tracking.cityId || null,
      source: tracking.source || 'professional_punch_in',
      metricDate: tracking.metricDate || getIstDateKey(),
    });

    if (response.FaceMatches && response.FaceMatches.length > 0) {
      // Find the highest similarity match
      const bestMatch = response.FaceMatches.reduce((prev, current) => {
        return (prev.Similarity > current.Similarity) ? prev : current;
      });

      return {
        isMatch: bestMatch.Similarity >= threshold,
        confidence: bestMatch.Similarity
      };
    }

    // No faces matched the threshold
    return { isMatch: false, confidence: 0 };

  } catch (error) {
    logger.error('[FaceService] Face match failed', error.message);
    
    // Check if Rekognition couldn't find a face in the provided image
    if (error.name === 'InvalidParameterException' && error.message.includes('There are no faces in the image')) {
      throw new Error('No face detected in the live selfie.');
    }

    throw new Error('Face matching service unavailable.');
  }
}

module.exports = {
  verifyFaceMatch
};
