const pool = require('../config/db');
const logger = require('../utils/logger');
const { verifyFaceMatch } = require('../utils/faceService');
const { rekognition, DetectFacesCommand, CompareFacesCommand } = require('../config/awsConfig');
const { getSignedS3Url, uploadToS3 } = require('../utils/s3SelfPunch');
const { ensureProfessionalLeaveSchema } = require('../utils/professionalLeaveSchema');
const { sendTrackedRekognition, trackSuccessfulAttendanceEvent } = require('../utils/cityTrafficCost');

let attendanceColumnsEnsured = false;

const ensureProfessionalAttendanceColumns = async (client) => {
  if (attendanceColumnsEnsured) return;

  await client.query(`
    ALTER TABLE professional_attendance
      ADD COLUMN IF NOT EXISTS punch_in_latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_in_longitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_out_latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_out_longitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS punch_in_photo_url VARCHAR(1024),
      ADD COLUMN IF NOT EXISTS punch_out_photo_url VARCHAR(1024),
      ADD COLUMN IF NOT EXISTS auto_punched_out BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS out_address TEXT
  `);

  attendanceColumnsEnsured = true;
};

const parseNumericCoordinate = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const getIstDateKey = (value = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(value);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};

const getTodayIST = () => getIstDateKey(new Date());

const livenessEnvNumber = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const LIVENESS_CONFIG = {
  enabled: String(process.env.PROFESSIONAL_LIVENESS_ENABLED ?? 'true').toLowerCase() !== 'false',
  allowMultipleFaces: String(process.env.PROFESSIONAL_LIVENESS_ALLOW_MULTI_FACE ?? 'true').toLowerCase() !== 'false',
  requireActiveChallenge: String(process.env.PROFESSIONAL_LIVENESS_REQUIRE_ACTIVE_CHALLENGE ?? 'true').toLowerCase() !== 'false',
  smartMode: String(process.env.PROFESSIONAL_LIVENESS_SMART_MODE ?? 'true').toLowerCase() !== 'false',
  minFaceConfidence: livenessEnvNumber('PROFESSIONAL_LIVENESS_MIN_FACE_CONFIDENCE', 85),
  minBrightness: livenessEnvNumber('PROFESSIONAL_LIVENESS_MIN_BRIGHTNESS', 35),
  minSharpness: livenessEnvNumber('PROFESSIONAL_LIVENESS_MIN_SHARPNESS', 35),
  maxYaw: livenessEnvNumber('PROFESSIONAL_LIVENESS_MAX_YAW', 25),
  maxRoll: livenessEnvNumber('PROFESSIONAL_LIVENESS_MAX_ROLL', 25),
  maxPitch: livenessEnvNumber('PROFESSIONAL_LIVENESS_MAX_PITCH', 20),
  smartMinFaceConfidence: livenessEnvNumber('PROFESSIONAL_LIVENESS_SMART_MIN_FACE_CONFIDENCE', 92),
  smartMinBrightness: livenessEnvNumber('PROFESSIONAL_LIVENESS_SMART_MIN_BRIGHTNESS', 42),
  smartMinSharpness: livenessEnvNumber('PROFESSIONAL_LIVENESS_SMART_MIN_SHARPNESS', 42),
  smartMaxYaw: livenessEnvNumber('PROFESSIONAL_LIVENESS_SMART_MAX_YAW', 12),
  smartMaxRoll: livenessEnvNumber('PROFESSIONAL_LIVENESS_SMART_MAX_ROLL', 10),
  smartMaxPitch: livenessEnvNumber('PROFESSIONAL_LIVENESS_SMART_MAX_PITCH', 10),
  minChallengeYawDelta: livenessEnvNumber('PROFESSIONAL_LIVENESS_MIN_CHALLENGE_YAW_DELTA', 12),
  minFrameSimilarity: livenessEnvNumber('PROFESSIONAL_LIVENESS_MIN_FRAME_SIMILARITY', 80),
};

const parseLivenessFrames = (rawFrames) => {
  if (Array.isArray(rawFrames)) {
    return rawFrames.filter((item) => typeof item === 'string' && item.trim().length > 0);
  }

  if (typeof rawFrames === 'string' && rawFrames.trim()) {
    try {
      const parsed = JSON.parse(rawFrames);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string' && item.trim().length > 0);
      }
    } catch (_) {
      return [];
    }
  }

  return [];
};

const getChallengeFrameForFaceMatch = (rawFrames) => {
  const parsed = parseLivenessFrames(rawFrames);
  if (parsed.length < 2) return null;
  const [, frameB] = parsed;
  return frameB || null;
};

const decodeBase64Image = (value) => {
  const base64Data = String(value || '').replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
};

const getFaceArea = (face) => {
  const box = face?.BoundingBox || {};
  return Number(box.Width || 0) * Number(box.Height || 0);
};

const pickPrimaryFace = (faces = []) => {
  if (!faces.length) return null;
  return faces.reduce((best, face) => {
    if (!best) return face;
    const bestArea = getFaceArea(best);
    const faceArea = getFaceArea(face);
    if (faceArea > bestArea) return face;
    if (faceArea < bestArea) return best;
    return Number(face?.Confidence || 0) > Number(best?.Confidence || 0) ? face : best;
  }, null);
};

const detectSingleFace = async (base64Image, stage = 'front', tracking = {}) => {
  const imageBuffer = decodeBase64Image(base64Image);
  if (!imageBuffer.length) {
    return { ok: false, message: 'Invalid selfie image provided.' };
  }

  let detectResult;
  try {
    detectResult = await sendTrackedRekognition({
      client: rekognition,
      command: new DetectFacesCommand({
        Image: { Bytes: imageBuffer },
        Attributes: ['ALL'],
      }),
      cityId: tracking.cityId || null,
      source: tracking.source || 'professional_punch_in',
      metricDate: tracking.metricDate || getTodayIST(),
    });
  } catch (error) {
    logger.error('[Attendance] Liveness pre-check failed', error.message || error);
    return { ok: false, message: 'Liveness service unavailable. Please try again.' };
  }

  const faces = detectResult?.FaceDetails ?? [];
  if (!faces.length) {
    return {
      ok: false,
      message: 'No clear face detected. Please retake selfie.',
    };
  }

  if (!LIVENESS_CONFIG.allowMultipleFaces && faces.length !== 1) {
    return {
      ok: false,
      message: 'Only one face should be visible in frame.',
    };
  }

  const face = pickPrimaryFace(faces);
  if (!face) {
    return {
      ok: false,
      message: 'No clear face detected. Please retake selfie.',
    };
  }
  const brightness = Number(face?.Quality?.Brightness ?? 0);
  const sharpness = Number(face?.Quality?.Sharpness ?? 0);
  const faceConfidence = Number(face?.Confidence ?? 0);
  const yaw = Number(face?.Pose?.Yaw ?? 0);
  const roll = Number(face?.Pose?.Roll ?? 0);
  const pitch = Number(face?.Pose?.Pitch ?? 0);
  const eyesOpen = face?.EyesOpen?.Value !== false;
  const eyesOpenValue = face?.EyesOpen?.Value;
  const eyesOpenConfidence = Number(face?.EyesOpen?.Confidence ?? 0);
  const faceOccluded = face?.FaceOccluded?.Value === true && (face?.FaceOccluded?.Confidence ?? 0) > 85;
  const sunglasses = face?.Sunglasses?.Value === true && (face?.Sunglasses?.Confidence ?? 0) > 85;

  if (
    brightness < LIVENESS_CONFIG.minBrightness ||
    sharpness < LIVENESS_CONFIG.minSharpness ||
    faceConfidence < LIVENESS_CONFIG.minFaceConfidence
  ) {
    return { ok: false, message: 'Face quality is too low. Use better lighting and hold camera steady.' };
  }

  const poseExceeded =
    Math.abs(roll) > LIVENESS_CONFIG.maxRoll ||
    Math.abs(pitch) > LIVENESS_CONFIG.maxPitch ||
    (stage === 'front' ? Math.abs(yaw) > LIVENESS_CONFIG.maxYaw : Math.abs(yaw) > 50);
  if (poseExceeded) {
    return {
      ok: false,
      message: stage === 'front'
        ? 'Please keep your face straight and centered in frame.'
        : 'Please keep your face clearly visible and steady in frame.',
    };
  }

  if (stage !== 'blink' && !eyesOpen) {
    return { ok: false, message: 'Please keep your eyes open and retake the selfie.' };
  }

  if (faceOccluded || sunglasses) {
    return { ok: false, message: 'Face appears covered. Remove mask/sunglasses and retry.' };
  }

  return {
    ok: true,
    buffer: imageBuffer,
    metrics: {
      yaw,
      roll,
      pitch,
      brightness,
      sharpness,
      faceConfidence,
      eyesOpen,
      eyesOpenValue,
      eyesOpenConfidence,
    },
  };
};

const verifyFramesBelongToSamePerson = async (sourceBuffer, targetBuffer, tracking = {}) => {
  try {
    const response = await sendTrackedRekognition({
      client: rekognition,
      command: new CompareFacesCommand({
        SourceImage: { Bytes: sourceBuffer },
        TargetImage: { Bytes: targetBuffer },
        SimilarityThreshold: LIVENESS_CONFIG.minFrameSimilarity,
      }),
      cityId: tracking.cityId || null,
      source: tracking.source || 'professional_punch_in',
      metricDate: tracking.metricDate || getTodayIST(),
    });

    if (!response?.FaceMatches?.length) {
      return { ok: false, similarity: 0 };
    }

    const best = response.FaceMatches.reduce(
      (prev, current) => (Number(prev?.Similarity || 0) > Number(current?.Similarity || 0) ? prev : current),
      response.FaceMatches[0]
    );
    return {
      ok: Number(best?.Similarity || 0) >= LIVENESS_CONFIG.minFrameSimilarity,
      similarity: Number(best?.Similarity || 0),
    };
  } catch (error) {
    logger.error('[Attendance] Liveness frame comparison failed', error.message || error);
    return { ok: false, similarity: 0 };
  }
};

const runLivenessPrecheck = async (selfieBase64, options = {}) => {
  if (!LIVENESS_CONFIG.enabled) {
    return { ok: true, skipped: true };
  }

  const parsedFrames = parseLivenessFrames(options?.livenessFrames);
  if (parsedFrames.length === 1 && selfieBase64) {
    parsedFrames.unshift(selfieBase64);
  }
  const primaryResult = await detectSingleFace(selfieBase64, 'front', options);
  if (!primaryResult.ok) {
    return primaryResult;
  }

  const primaryMetrics = primaryResult.metrics || {};
  const isSmartSuspicious =
    Number(primaryMetrics.faceConfidence ?? 0) < LIVENESS_CONFIG.smartMinFaceConfidence ||
    Number(primaryMetrics.brightness ?? 0) < LIVENESS_CONFIG.smartMinBrightness ||
    Number(primaryMetrics.sharpness ?? 0) < LIVENESS_CONFIG.smartMinSharpness ||
    Math.abs(Number(primaryMetrics.yaw ?? 0)) > LIVENESS_CONFIG.smartMaxYaw ||
    Math.abs(Number(primaryMetrics.roll ?? 0)) > LIVENESS_CONFIG.smartMaxRoll ||
    Math.abs(Number(primaryMetrics.pitch ?? 0)) > LIVENESS_CONFIG.smartMaxPitch;

  const challengeRequired = LIVENESS_CONFIG.requireActiveChallenge || (LIVENESS_CONFIG.smartMode && isSmartSuspicious);

  if (!challengeRequired) {
    return { ok: true };
  }

  if (parsedFrames.length < 2) {
    return {
      ok: false,
      needsChallenge: true,
      message: 'Quick live challenge required. Please capture one more selfie with head turn.',
    };
  }

  const [frameA, frameB, frameC] = parsedFrames;
  if (!frameA || !frameB) {
    return {
      ok: false,
      needsChallenge: true,
      message: 'Live challenge incomplete. Capture both selfie steps and retry.',
    };
  }
  if (frameA === frameB) {
    return {
      ok: false,
      message: 'Live challenge failed. Capture two different selfies.',
    };
  }
  const direction = String(options?.livenessChallenge || '').trim().toLowerCase();

  const frameAResult = await detectSingleFace(frameA, 'front', options);
  if (!frameAResult.ok) return frameAResult;
  const stageForB = direction === 'blink' ? 'blink' : (direction === 'left' ? 'left' : 'right');
  const frameBResult = await detectSingleFace(frameB, stageForB, options);
  if (!frameBResult.ok) return frameBResult;

  const samePerson = await verifyFramesBelongToSamePerson(frameAResult.buffer, frameBResult.buffer, options);
  if (!samePerson.ok) {
    return {
      ok: false,
      message: 'Live challenge failed. Face mismatch across steps.',
    };
  }

  const yawA = Number(frameAResult.metrics?.yaw ?? 0);
  const yawB = Number(frameBResult.metrics?.yaw ?? 0);
  const yawDelta = yawB - yawA;
  const minDelta = LIVENESS_CONFIG.minChallengeYawDelta;

  if (direction === 'blink') {
    const eyesOpenA = frameAResult.metrics?.eyesOpen === true || frameAResult.metrics?.eyesOpenValue === true;
    const eyesOpenB = frameBResult.metrics?.eyesOpen === true || frameBResult.metrics?.eyesOpenValue === true;

    if (!eyesOpenA) {
      return { ok: false, message: 'Please keep eyes open in step 1 and retry.' };
    }
    if (eyesOpenB) {
      return { ok: false, message: 'Blink not detected. Please blink in step 2 and retry.' };
    }
    return { ok: true };
  }

  if (direction === 'right_left' || direction === 'right-left') {
    if (!frameC) {
      return {
        ok: false,
        needsChallenge: true,
        message: 'Final live check required. Capture LEFT-turn selfie and retry.',
      };
    }

    const frameCResult = await detectSingleFace(frameC, 'left', options);
    if (!frameCResult.ok) return frameCResult;

    const samePersonBC = await verifyFramesBelongToSamePerson(frameBResult.buffer, frameCResult.buffer, options);
    if (!samePersonBC.ok) {
      return {
        ok: false,
        message: 'Live challenge failed. Face mismatch on final step.',
      };
    }

    const yawC = Number(frameCResult.metrics?.yaw ?? 0);
    const yawDeltaRight = yawB - yawA;
    const yawDeltaLeft = yawC - yawB;

    if (Math.abs(yawDeltaRight) < minDelta) {
      return { ok: false, message: 'Please turn your head RIGHT in step 2 and retry.' };
    }
    if (Math.abs(yawDeltaLeft) < minDelta) {
      return { ok: false, message: 'Please turn your head LEFT in final step and retry.' };
    }
    return { ok: true };
  }

  if (direction === 'left') {
    if (Math.abs(yawDelta) < minDelta) {
      return { ok: false, message: 'Please turn your head LEFT in step 2 and retry.' };
    }
  } else if (direction === 'right') {
    if (Math.abs(yawDelta) < minDelta) {
      return { ok: false, message: 'Please turn your head RIGHT in step 2 and retry.' };
    }
  } else if (Math.abs(yawDelta) < minDelta) {
    return { ok: false, message: 'Head movement not detected. Please follow live challenge and retry.' };
  }

  return { ok: true };
};

const uploadPunchPhotoIfPossible = async ({ professionalId, dayKey, type, selfieBase64 }) => {
  if (!selfieBase64) return null;
  try {
    const cleanBase64 = String(selfieBase64).replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) return null;
    const key = `professional-attendance/${professionalId}/${dayKey}/${type}-${Date.now()}.jpg`;
    return await uploadToS3(buffer, key, 'image/jpeg');
  } catch (error) {
    logger.warn(`[Attendance] Failed to upload ${type} photo for ${professionalId}: ${error.message}`);
    return null;
  }
};

/**
 * @desc    Punch in using live selfie
 * @route   POST /api/professional/attendance/punch-in
 * @access  Private (Professional)
 */
const punchIn = async (req, res) => {
  const { professional_id, ward_id, zone_id, city_id } = req.professional;
  const { selfie_base64, latitude, longitude, liveness_frames, liveness_challenge } = req.body;

  if (!selfie_base64) {
    return res.status(400).json({ success: false, message: 'selfie_base64 is required.' });
  }

  const today = getTodayIST();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureProfessionalAttendanceColumns(client);
    await ensureProfessionalLeaveSchema();

    const leaveCheck = await client.query(
      `SELECT leave_type
       FROM professional_leave_requests
       WHERE professional_id = $1
         AND requested_date = $2
         AND status = 'approved'
       LIMIT 1`,
      [professional_id, today]
    );
    if (leaveCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `You are on approved ${leaveCheck.rows[0].leave_type} leave for today.`,
      });
    }

    // 1. Check if already punched in today
    const checkQuery = `
      SELECT id FROM professional_attendance 
      WHERE professional_id = $1 AND date = $2
      FOR UPDATE
    `;
    const checkResult = await client.query(checkQuery, [professional_id, today]);

    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'You have already punched in today.' });
    }

    // 2. Liveness pre-check to reduce photo spoof attempts
    const liveness = await runLivenessPrecheck(selfie_base64, {
      livenessFrames: liveness_frames,
      livenessChallenge: liveness_challenge,
      cityId: city_id,
      source: 'professional_punch_in',
      metricDate: today,
    });
    if (!liveness.ok) {
      if (liveness.needsChallenge) {
        await client.query('ROLLBACK');
        return res.status(428).json({
          success: false,
          code: 'LIVENESS_CHALLENGE_REQUIRED',
          message: liveness.message || 'Quick live challenge required.',
        });
      }
      await client.query('ROLLBACK');
      return res.status(422).json({
        success: false,
        code: 'LIVENESS_FAILED',
        message: liveness.message || 'Liveness check failed. Please retry with a live selfie.',
      });
    }

    // 3. Get the reference selfie from professional profile
    const profileQuery = `SELECT selfie_url FROM professional_employees WHERE id = $1 AND is_active = true`;
    const profileResult = await client.query(profileQuery, [professional_id]);

    if (profileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Profile not found or deactivated.' });
    }

    const { selfie_url: sourceS3Key } = profileResult.rows[0];

    // 4. Perform Face Verification
    let matchResult;
    try {
      matchResult = await verifyFaceMatch(sourceS3Key, selfie_base64, 80, { cityId: city_id, source: 'professional_punch_in', metricDate: today });
    } catch (faceErr) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: faceErr.message });
    }

    if (!matchResult.isMatch) {
      await client.query('ROLLBACK');
      logger.warn(`[Attendance] Face match failed for ${professional_id}. Confidence: ${matchResult.confidence}`);
      return res.status(403).json({ 
        success: false, 
        message: 'Face not recognized. Please ensure good lighting and try again.',
        confidence: matchResult.confidence
      });
    }

    const challengeFrame = getChallengeFrameForFaceMatch(liveness_frames);
    if (challengeFrame) {
      let challengeMatchResult;
      try {
        challengeMatchResult = await verifyFaceMatch(sourceS3Key, challengeFrame, 80, { cityId: city_id, source: 'professional_punch_in', metricDate: today });
      } catch (faceErr) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: faceErr.message });
      }

      if (!challengeMatchResult.isMatch) {
        await client.query('ROLLBACK');
        logger.warn(`[Attendance] Challenge frame face match failed for ${professional_id}. Confidence: ${challengeMatchResult.confidence}`);
        return res.status(403).json({
          success: false,
          message: 'Live challenge face not recognized. Please retry.',
          confidence: challengeMatchResult.confidence
        });
      }
    }

    const punchInPhotoKey = await uploadPunchPhotoIfPossible({
      professionalId: professional_id,
      dayKey: today,
      type: 'punch-in',
      selfieBase64: selfie_base64
    });

    // 5. Insert Punch In record
    const insertQuery = `
      INSERT INTO professional_attendance (
        professional_id, date, punch_in, ward_id, zone_id, city_id,
        punch_in_latitude, punch_in_longitude, punch_in_photo_url
      )
      VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8)
      RETURNING punch_in
    `;

    const { rows } = await client.query(insertQuery, [
      professional_id,
      today,
      ward_id,
      zone_id,
      city_id,
      parseNumericCoordinate(latitude),
      parseNumericCoordinate(longitude),
      punchInPhotoKey
    ]);

    await client.query('COMMIT');
    
    logger.info(`[Attendance] Professional ${professional_id} punched in successfully.`);
    trackSuccessfulAttendanceEvent({
      cityId: city_id,
      source: 'professional_punch_in',
      metricDate: today,
      attendanceCount: 1,
    });

    res.json({ success: true, punch_in_time: rows[0].punch_in });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`[Attendance] Punch-in failed for ${professional_id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  } finally {
    client.release();
  }
};

/**
 * @desc    Punch out
 * @route   POST /api/professional/attendance/punch-out
 * @access  Private (Professional)
 */
const punchOut = async (req, res) => {
  const { professional_id, city_id } = req.professional;
  const { selfie_base64, latitude, longitude, liveness_frames, liveness_challenge } = req.body;
  const today = getTodayIST();

  if (!selfie_base64) {
    return res.status(400).json({ success: false, message: 'selfie_base64 is required for punch out.' });
  }

  try {
    await ensureProfessionalAttendanceColumns(pool);
    await ensureProfessionalLeaveSchema();

    const leaveCheck = await pool.query(
      `SELECT leave_type
       FROM professional_leave_requests
       WHERE professional_id = $1
         AND requested_date = $2
         AND status = 'approved'
       LIMIT 1`,
      [professional_id, today]
    );
    if (leaveCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: `You are on approved ${leaveCheck.rows[0].leave_type} leave for today.`,
      });
    }

    // 1. Liveness pre-check to reduce photo spoof attempts
    const liveness = await runLivenessPrecheck(selfie_base64, {
      livenessFrames: liveness_frames,
      livenessChallenge: liveness_challenge,
      cityId: city_id,
      source: 'professional_punch_out',
      metricDate: today,
    });
    if (!liveness.ok) {
      if (liveness.needsChallenge) {
        return res.status(428).json({
          success: false,
          code: 'LIVENESS_CHALLENGE_REQUIRED',
          message: liveness.message || 'Quick live challenge required.',
        });
      }
      return res.status(422).json({
        success: false,
        code: 'LIVENESS_FAILED',
        message: liveness.message || 'Liveness check failed. Please retry with a live selfie.',
      });
    }

    // 2. Get the reference selfie from professional profile
    const profileQuery = `SELECT selfie_url FROM professional_employees WHERE id = $1 AND is_active = true`;
    const profileResult = await pool.query(profileQuery, [professional_id]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Profile not found or deactivated.' });
    }

    const { selfie_url: sourceS3Key } = profileResult.rows[0];

    // 3. Perform Face Verification before punch out
    let matchResult;
    try {
      matchResult = await verifyFaceMatch(sourceS3Key, selfie_base64, 80, { cityId: city_id, source: 'professional_punch_out', metricDate: today });
    } catch (faceErr) {
      return res.status(400).json({ success: false, message: faceErr.message });
    }

    if (!matchResult.isMatch) {
      logger.warn(`[Attendance] Punch-out face match failed for ${professional_id}. Confidence: ${matchResult.confidence}`);
      return res.status(403).json({
        success: false,
        message: 'Face not recognized. Please ensure good lighting and try again.',
        confidence: matchResult.confidence
      });
    }

    const challengeFrame = getChallengeFrameForFaceMatch(liveness_frames);
    if (challengeFrame) {
      let challengeMatchResult;
      try {
        challengeMatchResult = await verifyFaceMatch(sourceS3Key, challengeFrame, 80, { cityId: city_id, source: 'professional_punch_out', metricDate: today });
      } catch (faceErr) {
        return res.status(400).json({ success: false, message: faceErr.message });
      }

      if (!challengeMatchResult.isMatch) {
        logger.warn(`[Attendance] Punch-out challenge frame match failed for ${professional_id}. Confidence: ${challengeMatchResult.confidence}`);
        return res.status(403).json({
          success: false,
          message: 'Live challenge face not recognized. Please retry.',
          confidence: challengeMatchResult.confidence
        });
      }
    }

    const punchOutPhotoKey = await uploadPunchPhotoIfPossible({
      professionalId: professional_id,
      dayKey: today,
      type: 'punch-out',
      selfieBase64: selfie_base64
    });

    // We calculate hours worked dynamically in the query
    const updateQuery = `
      UPDATE professional_attendance 
      SET
        punch_out = NOW(),
        punch_out_latitude = $3,
        punch_out_longitude = $4,
        punch_out_photo_url = COALESCE($5, punch_out_photo_url)
      WHERE professional_id = $1 AND date = $2 AND punch_out IS NULL
      RETURNING punch_out, EXTRACT(EPOCH FROM (NOW() - punch_in)) / 3600 AS hours_worked
    `;

    const { rows } = await pool.query(updateQuery, [
      professional_id,
      today,
      parseNumericCoordinate(latitude),
      parseNumericCoordinate(longitude),
      punchOutPhotoKey
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'No open punch-in record found for today. You may have already punched out.' 
      });
    }

    logger.info(`[Attendance] Professional ${professional_id} punched out successfully.`);

    trackSuccessfulAttendanceEvent({
      cityId: city_id,
      source: 'professional_punch_out',
      metricDate: today,
      attendanceCount: 1,
    });

    res.json({ 
      success: true, 
      punch_out_time: rows[0].punch_out,
      hours_worked: parseFloat(rows[0].hours_worked).toFixed(2)
    });

  } catch (error) {
    logger.error(`[Attendance] Punch-out failed for ${professional_id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

/**
 * @desc    Get monthly attendance
 * @route   GET /api/professional/attendance/monthly?month=YYYY-MM
 * @access  Private (Professional)
 */
const getMonthlyAttendance = async (req, res) => {
  const { professional_id } = req.professional;
  let { month } = req.query;

  // Default to current month if not provided
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    month = `${yyyy}-${mm}`;
  }

  const [yyyy, mm] = month.split('-');

  try {
    await ensureProfessionalLeaveSchema();
    const query = `
      SELECT 
        date::text AS date,
        punch_in, 
        punch_out,
        CASE WHEN punch_out IS NULL AND date < CURRENT_DATE THEN NULL ELSE EXTRACT(EPOCH FROM (COALESCE(punch_out, NOW()) - punch_in)) / 3600 END AS hours_worked
      FROM professional_attendance
      WHERE professional_id = $1 
        AND EXTRACT(YEAR FROM date) = $2 
        AND EXTRACT(MONTH FROM date) = $3
      ORDER BY date DESC
    `;

    const { rows } = await pool.query(query, [professional_id, yyyy, mm]);
    const leaveResult = await pool.query(
      `SELECT
         id,
         requested_date::text AS requested_date,
         leave_type,
         status,
         reason,
         requested_at,
         reviewed_at,
         review_note,
         u.name AS reviewed_by_name
       FROM professional_leave_requests plr
       LEFT JOIN users u ON u.user_id = plr.reviewed_by
       WHERE plr.professional_id = $1
         AND EXTRACT(YEAR FROM plr.requested_date) = $2
         AND EXTRACT(MONTH FROM plr.requested_date) = $3`,
      [professional_id, yyyy, mm]
    );
    const leaveByDate = {};
    leaveResult.rows.forEach((row) => {
      const key = String(row.requested_date || '').slice(0, 10);
      leaveByDate[key] = row;
    });

    const profileResult = await pool.query(
      `SELECT city_id, zone_id, ward_id, kothi_id
       FROM professional_employees
       WHERE id = $1
       LIMIT 1`,
      [professional_id]
    );
    const profileScope = profileResult.rows[0] || {};
    const holidayResult = await pool.query(
      `SELECT
         h.id,
         h.holiday_date::text AS holiday_date,
         h.holiday_name,
         h.description
       FROM professional_holidays h
       WHERE EXTRACT(YEAR FROM h.holiday_date) = $1
         AND EXTRACT(MONTH FROM h.holiday_date) = $2
         AND h.city_id = $3
         AND (h.zone_id IS NULL OR h.zone_id = $4)
         AND (h.ward_id IS NULL OR h.ward_id = $5)
         AND (h.kothi_id IS NULL OR h.kothi_id = $6)
       ORDER BY h.holiday_date ASC`,
      [yyyy, mm, profileScope.city_id || null, profileScope.zone_id || null, profileScope.ward_id || null, profileScope.kothi_id || null]
    );
    const holidayByDate = {};
    holidayResult.rows.forEach((row) => {
      const key = String(row.holiday_date || '').slice(0, 10);
      holidayByDate[key] = row;
    });

    let totalWorkingDays = 0;
    let totalPresent = 0;
    let totalHalfDay = 0;
    let totalAbsent = 0;
    let totalLeaveApproved = 0;
    let totalLeavePending = 0;
    let totalLeaveRejected = 0;
    let totalHoliday = 0;

    // Basic calculation
    const daysInMonth = new Date(yyyy, mm, 0).getDate();
    const records = [];

    // Map DB rows to a dictionary by date string 'YYYY-MM-DD'
    const attendanceDict = {};
    rows.forEach(r => {
      const dStr = new Date(r.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      attendanceDict[dStr] = r;
    });

    for (let i = 1; i <= daysInMonth; i++) {
      const dStr = `${yyyy}-${mm}-${String(i).padStart(2, '0')}`;
      const record = attendanceDict[dStr];

      // Exclude future dates from absent calculation
      const todayIst = getTodayIST();
      const isFuture = dStr > todayIst;
      if (record) {
        let hours = 0;
        let status = 'absent';
        let displayHours = '-';

        if (record.punch_in && record.punch_out) {
          // Fully completed session ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â use stored hours_worked
          hours = record.hours_worked != null ? parseFloat(record.hours_worked) : 0;
          status = hours >= 4 ? 'present' : 'half-day';
          displayHours = hours.toFixed(2);
        } else if (record.punch_in && !record.punch_out) {
          // Punched in but no punch-out ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â counts as present, hours shown as '-'
          status = 'present';
          displayHours = '-'; // Don't show live working time if punch-out not done
        }
        // If neither punch_in nor punch_out, status stays 'absent'

        
        records.push({
          date: dStr,
          punch_in: record.punch_in,
          punch_out: record.punch_out,
          hours_worked: displayHours,
          status,
          leave: leaveByDate[dStr] || null,
          holiday: holidayByDate[dStr] || null,
        });
        
        if (status === 'present') totalPresent++;
        else if (status === 'half-day') totalHalfDay++;
        totalWorkingDays++;

      } else if (!isFuture || leaveByDate[dStr] || holidayByDate[dStr]) {
        const leave = leaveByDate[dStr] || null;
        const holiday = holidayByDate[dStr] || null;
        let status = 'absent';
        if (leave?.status === 'approved') status = 'leave-approved';
        if (leave?.status === 'pending') status = 'leave-pending';
        if (leave?.status === 'rejected') status = 'leave-rejected';
        if (!leave && holiday) status = 'holiday';

        records.push({
          date: dStr,
          punch_in: null,
          punch_out: null,
          hours_worked: (status.startsWith('leave-') || status === 'holiday') ? '-' : '0.00',
          status,
          leave,
          holiday,
        });
        if (status === 'absent' && !isFuture) totalAbsent++;
        if (status === 'leave-approved') totalLeaveApproved++;
        if (status === 'leave-pending') totalLeavePending++;
        if (status === 'leave-rejected') totalLeaveRejected++;
        if (status === 'holiday') totalHoliday++;
        if (!isFuture) totalWorkingDays++;
      }
    }

    const totalPayableDays = totalPresent + totalHalfDay + totalLeaveApproved + totalHoliday;

    res.json({
      success: true,
      data: records.reverse(), // Newest first
      summary: {
        total_present: totalPresent,
        total_half_day: totalHalfDay,
        total_absent: totalAbsent,
        total_leave_approved: totalLeaveApproved,
        total_leave_pending: totalLeavePending,
        total_leave_rejected: totalLeaveRejected,
        total_holiday: totalHoliday,
        total_payable_days: totalPayableDays,
        total_working_days: totalWorkingDays
      }
    });

  } catch (error) {
    logger.error(`[Attendance] Monthly get failed for ${professional_id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

/**
 * @desc    Get today's attendance status for logged-in professional
 * @route   GET /api/professional/attendance/status
 * @access  Private (Professional)
 */
const getTodayStatus = async (req, res) => {
  const { professional_id } = req.professional;
  const today = getTodayIST();

  try {
    await ensureProfessionalAttendanceColumns(pool);

    const attendanceResult = await pool.query(
      `SELECT date, punch_in, punch_out
       FROM professional_attendance
       WHERE professional_id = $1 AND date = $2
       ORDER BY id DESC
       LIMIT 1`,
      [professional_id, today]
    );

    if (attendanceResult.rows.length > 0) {
      const row = attendanceResult.rows[0];
      const hasPunchIn = Boolean(row.punch_in);
      const hasPunchOut = Boolean(row.punch_out);
      const status = hasPunchIn ? (hasPunchOut ? 'done' : 'present') : 'absent';

      return res.json({
        success: true,
        data: {
          date: row.date,
          punch_in: row.punch_in,
          punch_out: row.punch_out,
          status,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        date: today,
        punch_in: null,
        punch_out: null,
        status: 'absent',
      },
    });
  } catch (error) {
    logger.error(`[Attendance] Today status get failed for ${professional_id}`, error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

/**
 * @desc    Get professional profile
 * @route   GET /api/professional/profile
 * @access  Private (Professional)
 */
const getProfile = async (req, res) => {
  const { professional_id } = req.professional;

  try {
    const query = `
      SELECT 
        p.id, p.full_name, p.mobile, p.email, p.selfie_url, p.face_locked, p.created_at,
        c.city_name, z.zone_name, s.sector_name as ward_name, w.ward_name as kothi_name
      FROM professional_employees p
      LEFT JOIN cities c ON p.city_id = c.city_id
      LEFT JOIN zones z ON p.zone_id = z.zone_id
      LEFT JOIN sectors s ON p.ward_id = s.sector_id
      LEFT JOIN wards w ON p.kothi_id = w.ward_id
      WHERE p.id = $1
    `;

    const { rows } = await pool.query(query, [professional_id]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Profile not found.' });
    }

    const profile = rows[0];

    // Generate signed URL for the selfie
    if (profile.selfie_url) {
      profile.selfie_url = await getSignedS3Url(profile.selfie_url, 900);
    }

    // Force face_locked true as requested (always true for this app level)
    profile.face_locked = true;

    res.json({ success: true, data: profile });

  } catch (error) {
    logger.error(`[Attendance] Profile get failed for ${professional_id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = {
  punchIn,
  punchOut,
  getMonthlyAttendance,
  getTodayStatus,
  getProfile
};
