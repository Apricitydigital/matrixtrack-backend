const {
  rekognition,
  CompareFacesCommand
} = require('../config/awsConfig');
const logger = require('./logger');

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;

/**
 * Compares a live selfie (base64) against an existing S3 object.
 * @param {string} sourceS3Key - The S3 object key of the stored face
 * @param {string} targetBase64 - The live base64 string
 * @param {number} threshold - Minimum similarity threshold (0-100)
 * @returns {Promise<{ isMatch: boolean, confidence: number }>}
 */
async function verifyFaceMatch(sourceS3Key, targetBase64, threshold = 80) {
  if (!AWS_S3_BUCKET) {
    logger.warn('[FaceService] AWS S3 bucket not configured. Bypassing face match (dev mode only).');
    // If not configured, we might reject or allow depending on environment.
    // For safety, we reject in production.
    return { isMatch: false, confidence: 0 };
  }

  try {
    // Accept either S3 object key or full S3 URL stored in DB.
    let normalizedSourceKey = String(sourceS3Key || '').trim();
    if (normalizedSourceKey.startsWith('http://') || normalizedSourceKey.startsWith('https://')) {
      try {
        const parsedUrl = new URL(normalizedSourceKey);
        normalizedSourceKey = decodeURIComponent(parsedUrl.pathname || '').replace(/^\/+/, '');
      } catch (_) {
        normalizedSourceKey = normalizedSourceKey.replace(/^https?:\/\/[^/]+\//i, '');
      }
    }

    if (!normalizedSourceKey) {
      throw new Error('Stored reference selfie is missing.');
    }

    // Strip base64 metadata if present (e.g., "data:image/jpeg;base64,")
    const base64Data = targetBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const compareCommand = new CompareFacesCommand({
      SourceImage: {
        S3Object: {
          Bucket: AWS_S3_BUCKET,
          Name: normalizedSourceKey
        }
      },
      TargetImage: {
        Bytes: imageBuffer
      },
      SimilarityThreshold: threshold
    });

    const response = await rekognition.send(compareCommand);

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
