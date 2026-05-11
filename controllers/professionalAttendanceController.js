const pool = require('../config/db');
const logger = require('../utils/logger');
const { verifyFaceMatch } = require('../utils/faceService');
const { getSignedS3Url, uploadToS3 } = require('../utils/s3SelfPunch');

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
      ADD COLUMN IF NOT EXISTS punch_out_photo_url VARCHAR(1024)
  `);

  attendanceColumnsEnsured = true;
};

const parseNumericCoordinate = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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
  const { selfie_base64, latitude, longitude } = req.body;

  if (!selfie_base64) {
    return res.status(400).json({ success: false, message: 'selfie_base64 is required.' });
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureProfessionalAttendanceColumns(client);

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

    // 2. Get the reference selfie from professional profile
    const profileQuery = `SELECT selfie_url FROM professional_employees WHERE id = $1 AND is_active = true`;
    const profileResult = await client.query(profileQuery, [professional_id]);

    if (profileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Profile not found or deactivated.' });
    }

    const { selfie_url: sourceS3Key } = profileResult.rows[0];

    // 3. Perform Face Verification
    let matchResult;
    try {
      matchResult = await verifyFaceMatch(sourceS3Key, selfie_base64, 80);
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

    const punchInPhotoKey = await uploadPunchPhotoIfPossible({
      professionalId: professional_id,
      dayKey: today,
      type: 'punch-in',
      selfieBase64: selfie_base64
    });

    // 4. Insert Punch In record
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
  const { professional_id } = req.professional;
  const { selfie_base64, latitude, longitude } = req.body;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  if (!selfie_base64) {
    return res.status(400).json({ success: false, message: 'selfie_base64 is required for punch out.' });
  }

  try {
    await ensureProfessionalAttendanceColumns(pool);

    // 1. Get the reference selfie from professional profile
    const profileQuery = `SELECT selfie_url FROM professional_employees WHERE id = $1 AND is_active = true`;
    const profileResult = await pool.query(profileQuery, [professional_id]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Profile not found or deactivated.' });
    }

    const { selfie_url: sourceS3Key } = profileResult.rows[0];

    // 2. Perform Face Verification before punch out
    let matchResult;
    try {
      matchResult = await verifyFaceMatch(sourceS3Key, selfie_base64, 80);
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
    const query = `
      SELECT 
        date, 
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

    let totalWorkingDays = 0;
    let totalPresent = 0;
    let totalHalfDay = 0;
    let totalAbsent = 0;

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
      const isFuture = new Date(dStr) > new Date();

      if (record) {
        let hours = 0;
        let status = 'absent';
        let displayHours = '-';

        if (record.punch_in && record.punch_out) {
          // Fully completed session — use stored hours_worked
          hours = record.hours_worked != null ? parseFloat(record.hours_worked) : 0;
          status = hours >= 4 ? 'present' : 'half-day';
          displayHours = hours.toFixed(2);
        } else if (record.punch_in && !record.punch_out) {
          // Punched in but no punch-out — counts as present, hours shown as '-'
          status = 'present';
          displayHours = '-'; // Don't show live working time if punch-out not done
        }
        // If neither punch_in nor punch_out, status stays 'absent'

        
        records.push({
          date: dStr,
          punch_in: record.punch_in,
          punch_out: record.punch_out,
          hours_worked: displayHours,
          status
        });
        
        if (status === 'present') totalPresent++;
        else if (status === 'half-day') totalHalfDay++;
        totalWorkingDays++;

      } else if (!isFuture) {
        records.push({
          date: dStr,
          punch_in: null,
          punch_out: null,
          hours_worked: '0.00',
          status: 'absent'
        });
        totalAbsent++;
        totalWorkingDays++;
      }
    }

    res.json({
      success: true,
      data: records.reverse(), // Newest first
      summary: {
        total_present: totalPresent,
        total_half_day: totalHalfDay,
        total_absent: totalAbsent,
        total_working_days: totalWorkingDays
      }
    });

  } catch (error) {
    logger.error(`[Attendance] Monthly get failed for ${professional_id}`, error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
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
  getProfile
};
