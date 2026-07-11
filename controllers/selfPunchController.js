const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const logger = require('../utils/logger');
const { encryptAadhar } = require('../utils/encryption');
const { uploadToS3, deleteFromS3 } = require('../utils/s3SelfPunch');
const socketio = require('../utils/socket');
const { trackCityTraffic, getIstDateKey } = require('../utils/cityTrafficCost');

// Multer memory storage to hold files before uploading to S3
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max across any single file
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'aadhar_doc') {
      if (!file.mimetype.match(/^image\/(jpeg|jpg|png)$/) && file.mimetype !== 'application/pdf') {
        return cb(new Error('Aadhar doc must be an image (jpg/png) or PDF.'));
      }
    } else if (file.fieldname === 'selfie') {
      if (!file.mimetype.match(/^image\/(jpeg|jpg|png)$/)) {
        return cb(new Error('Selfie must be an image (jpg/png).'));
      }
    }
    cb(null, true);
  }
}).fields([
  { name: 'aadhar_doc', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]);

// Strip basic HTML tags for basic sanitization
const sanitizeString = (str) => {
  if (!str) return str;
  return str.replace(/<[^>]*>?/gm, '').trim();
};

const resolveSubmitActorType = async (client) => {
  try {
    const { rows } = await client.query(`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'self_punch_actor_type'
    `);
    const labels = new Set(rows.map((r) => String(r.enumlabel || '').trim().toLowerCase()));
    if (labels.has('admin')) return 'admin';
    if (labels.has('supervisor')) return 'supervisor';
    return null;
  } catch (_error) {
    // If enum inspection fails, use current default path.
    return 'admin';
  }
};

const resolveValidKothiId = async (client, kothiIdRaw) => {
  if (!kothiIdRaw) {
    return null;
  }

  const parsed = parseInt(kothiIdRaw, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }

  try {
    const { rows } = await client.query(
      'SELECT id FROM kothi_assignments WHERE id = $1 LIMIT 1',
      [parsed]
    );
    if (rows.length) {
      return parsed;
    }

    // Some deployments keep kothi_assignments sparse while UI sends ward_id as kothi_id.
    // Try to backfill a minimal mapping row so FK remains valid and selection is preserved.
    await client.query(
      'INSERT INTO kothi_assignments (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [parsed]
    );

    const verify = await client.query(
      'SELECT id FROM kothi_assignments WHERE id = $1 LIMIT 1',
      [parsed]
    );

    return verify.rows.length ? parsed : null;
  } catch (error) {
    // If table lookup fails for any reason, treat kothi as optional and continue.
    logger.warn('[SelfPunch] kothi_assignments validation failed, storing NULL kothi_id', {
      message: error.message
    });
    return null;
  }
};

const resolveValidWardId = async (client, wardIdRaw, kothiIdRaw = null) => {
  if (!wardIdRaw) {
    return null;
  }

  const parsedWard = parseInt(wardIdRaw, 10);
  if (Number.isNaN(parsedWard)) {
    return null;
  }

  // 1) Direct ward_id (newer UI / canonical path)
  try {
    const directWard = await client.query(
      'SELECT ward_id, sector_id FROM wards WHERE ward_id = $1 LIMIT 1',
      [parsedWard]
    );
    if (directWard.rows.length) {
      return directWard.rows[0].ward_id;
    }

    // 2) Legacy UI path: ward_id actually carries sector_id
    // Prefer the selected kothi ward if it belongs to this sector.
    const sectorExists = await client.query(
      'SELECT sector_id FROM sectors WHERE sector_id = $1 LIMIT 1',
      [parsedWard]
    );

    if (sectorExists.rows.length) {
      const parsedKothi = parseInt(kothiIdRaw, 10);
      if (!Number.isNaN(parsedKothi)) {
        const kothiWard = await client.query(
          'SELECT ward_id FROM wards WHERE ward_id = $1 AND sector_id = $2 LIMIT 1',
          [parsedKothi, parsedWard]
        );
        if (kothiWard.rows.length) {
          return kothiWard.rows[0].ward_id;
        }
      }

      // Fallback to any ward under this sector.
      const anyWardInSector = await client.query(
        'SELECT ward_id FROM wards WHERE sector_id = $1 ORDER BY ward_id ASC LIMIT 1',
        [parsedWard]
      );
      if (anyWardInSector.rows.length) {
        return anyWardInSector.rows[0].ward_id;
      }
    }

    // 3) Last fallback: if kothi itself is a valid ward, use it.
    const parsedKothi = parseInt(kothiIdRaw, 10);
    if (!Number.isNaN(parsedKothi)) {
      const wardFromKothi = await client.query(
        'SELECT ward_id FROM wards WHERE ward_id = $1 LIMIT 1',
        [parsedKothi]
      );
      if (wardFromKothi.rows.length) {
        return wardFromKothi.rows[0].ward_id;
      }
    }
  } catch (error) {
    logger.warn('[SelfPunch] ward_id resolution failed', { message: error.message });
    return null;
  }

  return null;
};

const validateInput = (reqBody, reqFiles) => {
  const errors = {};

  const { full_name, mobile, email, aadhar_number, city_id, zone_id, ward_id, emp_code } = reqBody;

  if (!full_name || !sanitizeString(full_name)) errors.full_name = "Full name is required.";

  if (!emp_code || !String(emp_code).trim()) errors.emp_code = "Employee code is required.";
  
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    errors.mobile = "Mobile must be a valid 10-digit number.";
  }

  if (!email || !/^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(email)) {
    errors.email = "Valid email is required.";
  }

  if (!aadhar_number || !/^\d{12}$/.test(aadhar_number)) {
    errors.aadhar_number = "Aadhar number must be exactly 12 digits.";
  }

  if (!city_id || isNaN(parseInt(city_id, 10))) errors.city_id = "Valid city_id is required.";
  if (!zone_id || isNaN(parseInt(zone_id, 10))) errors.zone_id = "Valid zone_id is required.";
  if (!ward_id || isNaN(parseInt(ward_id, 10))) errors.ward_id = "Valid ward_id (sector in DB) is required.";
  
  // kothi_id is optional at UI level, but if provided must be integer
  if (reqBody.kothi_id && isNaN(parseInt(reqBody.kothi_id, 10))) {
    errors.kothi_id = "Valid kothi_id (ward in DB) is required if provided.";
  }

  if (!reqFiles || !reqFiles['aadhar_doc'] || !reqFiles['aadhar_doc'][0]) {
    errors.aadhar_doc = "Aadhar document (PDF or Image) is required.";
  }

  if (!reqFiles || !reqFiles['selfie'] || !reqFiles['selfie'][0]) {
    errors.selfie = "Selfie image is required.";
  }

  return Object.keys(errors).length > 0 ? errors : null;
};

const submitRequest = async (req, res) => {
  // 1. Validate Input
  const errors = validateInput(req.body, req.files);
  if (errors) {
    logger.warn('[SelfPunch] Validation failed for new request', { errors, ip: req.ip });
    return res.status(400).json({ success: false, errors });
  }

  const {
    full_name,
    mobile,
    email,
    aadhar_number,
    city_id,
    zone_id,
    ward_id,
    kothi_id,
    emp_code
  } = req.body;

  const sanitizedEmpCode = sanitizeString(emp_code) || null;

  const sanitizedFullName = sanitizeString(full_name);
  const sanitizedEmail = sanitizeString(email);

  // 2. Encrypt Aadhar
  let encryptedAadhar;
  try {
    encryptedAadhar = encryptAadhar(aadhar_number);
  } catch (err) {
    logger.error('[SelfPunch] Aadhar encryption failed', err);
    return res.status(500).json({ success: false, message: 'Internal server encryption error.' });
  }

  const client = await pool.connect();
  let aadharDocKey = null;
  let selfieKey = null;

  try {
    await client.query('BEGIN');

    // Daily cap: max 10 requests per mobile per day (IST)
    const mobileDailyCount = await client.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM self_punch_requests
        WHERE mobile = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      `,
      [mobile]
    );
    if ((mobileDailyCount.rows[0]?.cnt || 0) >= 10) {
      await client.query('ROLLBACK');
      logger.info('[SelfPunch] Daily mobile request cap reached', { mobile, ip: req.ip });
      return res.status(429).json({
        success: false,
        message: 'Daily limit reached: max 10 requests per mobile number per day.'
      });
    }

    const safeKothiId = await resolveValidKothiId(client, kothi_id);
    const safeWardId = await resolveValidWardId(client, ward_id, safeKothiId ?? kothi_id);
    if (!safeWardId) {
      await client.query('ROLLBACK');
      logger.warn('[SelfPunch] Invalid ward mapping for request', {
        requested_ward_id: ward_id ? parseInt(ward_id, 10) : null,
        requested_kothi_id: kothi_id ? parseInt(kothi_id, 10) : null,
        stored_kothi_id: safeKothiId
      });
      return res.status(400).json({
        success: false,
        errors: {
          ward_id: 'Selected ward/sector is not mapped to a valid ward. Please refresh location and try again.'
        }
      });
    }

    // Duplicate check: Same aadhar and mapped ward_id already pending or approved
    // Note: To check exact duplicate Aadhar securely, we query by the encrypted string directly
    const duplicateCheck = await client.query(`
      SELECT id FROM self_punch_requests 
      WHERE aadhar_number = $1 
        AND ward_id = $2 
        AND status IN ('pending', 'approved')
    `, [encryptedAadhar, safeWardId]);

    if (duplicateCheck.rowCount > 0) {
      await client.query('ROLLBACK');
      logger.info('[SelfPunch] Duplicate request rejected', { ward_id, ip: req.ip });
      return res.status(409).json({ 
        success: false, 
        message: 'A request for this Aadhar number at this location is already pending or approved.' 
      });
    }

    // Generate Request UUID
    const requestId = uuidv4();

    // 3. Upload to S3
    const aadharDocFile = req.files['aadhar_doc'][0];
    const selfieFile = req.files['selfie'][0];

    const aadharExt = aadharDocFile.mimetype === 'application/pdf' ? 'pdf' : aadharDocFile.mimetype.split('/')[1];
    const selfieExt = selfieFile.mimetype.split('/')[1];

    const aadharPath = `self-punch-requests/${requestId}/aadhar.${aadharExt}`;
    const selfiePath = `self-punch-requests/${requestId}/selfie.${selfieExt}`;

    logger.info(`[SelfPunch] Uploading files for ${requestId} to S3...`);
    aadharDocKey = await uploadToS3(aadharDocFile.buffer, aadharPath, aadharDocFile.mimetype);
    selfieKey = await uploadToS3(selfieFile.buffer, selfiePath, selfieFile.mimetype);

    // 4. Save to DB
    logger.info(`[SelfPunch] Inserting record ${requestId} into DB...`);
    const insertRequestQuery = `
      INSERT INTO self_punch_requests (
        id, full_name, mobile, email, aadhar_number, 
        aadhar_doc_url, selfie_url, 
        city_id, zone_id, ward_id, kothi_id, 
        emp_code, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
      RETURNING id;
    `;
    
    logger.info('[SelfPunch] Final location mapping', {
      requested_ward_id: parseInt(ward_id, 10),
      stored_ward_id: safeWardId,
      requested_kothi_id: kothi_id ? parseInt(kothi_id, 10) : null,
      stored_kothi_id: safeKothiId
    });

    await client.query(insertRequestQuery, [
      requestId,
      sanitizedFullName,
      mobile,
      sanitizedEmail,
      encryptedAadhar,
      aadharDocKey,
      selfieKey,
      parseInt(city_id, 10),
      parseInt(zone_id, 10),
      safeWardId,
      safeKothiId,
      sanitizedEmpCode
    ]);

    // 5. Insert Log Entry
    const submitActorType = await resolveSubmitActorType(client);
    if (submitActorType) {
      const insertLogQuery = `
        INSERT INTO self_punch_request_logs (request_id, action, performed_by_type, performed_by_id, note)
        VALUES ($1, 'submitted', $2, 0, 'Request submitted by worker')
      `;
      await client.query(insertLogQuery, [requestId, submitActorType]);
    } else {
      logger.warn('[SelfPunch] Skipping request log insert: self_punch_actor_type enum missing expected values.');
    }

    await client.query('COMMIT');
    logger.info(`[SelfPunch] Request ${requestId} saved successfully.`);

    // 6 & 7. Send Socket Notification to Supervisors
    try {
      const io = socketio.getIO();
      // Emitting to everyone for now, but ideally we'd target supervisors connected to this ward room
      // To target specifically:
      // io.to(`ward_${ward_id}`).emit('new_self_punch_request', { request_id: requestId, ward_id });
      
      io.emit('new_self_punch_request', { 
        request_id: requestId, 
        ward_id: safeWardId,
        zone_id: parseInt(zone_id, 10)
      });
      logger.info(`[SelfPunch] Socket notification emitted for ${requestId}.`);
    } catch (socketErr) {
      // Non-fatal, just log
      logger.warn(`[SelfPunch] Failed to emit socket notification for ${requestId}:`, socketErr.message);
    }

    // 8. Return Success
    return res.status(201).json({
      success: true,
      request_id: requestId,
      message: "Your request has been submitted. You'll be notified once approved."
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`[SelfPunch] Transaction failed. Rolling back DB and S3.`, {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });

    // Rollback S3 uploads if they happened
    if (aadharDocKey) await deleteFromS3(aadharDocKey);
    if (selfieKey) await deleteFromS3(selfieKey);

    if (
      error?.code === '23505' &&
      (error?.constraint === 'uidx_spr_mobile_pending' ||
        String(error?.detail || '').toLowerCase().includes('(mobile)'))
    ) {
      return res.status(409).json({
        success: false,
        message: 'DB still enforces single pending request per mobile. Drop uidx_spr_mobile_pending to allow multiple pending requests.'
      });
    }

    if (error?.code === '42703') {
      return res.status(500).json({
        success: false,
        message: 'Database schema is outdated for self-punch. Run safe structure migration.'
      });
    }

    if (
      error?.code === '23503' &&
      error?.constraint === 'self_punch_requests_ward_id_fkey'
    ) {
      return res.status(400).json({
        success: false,
        errors: {
          ward_id: 'Selected ward is invalid for current DB mapping.'
        }
      });
    }

    return res.status(500).json({ success: false, message: 'Internal server error during submission.' });
  } finally {
    client.release();
  }
};

// Error handling middleware for Multer limits/filters
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // A Multer error occurred when uploading.
    logger.warn('[SelfPunch] Multer Error', err.message);
    return res.status(400).json({ success: false, errors: { file: err.message } });
  } else if (err) {
    // An unknown error occurred.
    logger.warn('[SelfPunch] Upload Error', err.message);
    return res.status(400).json({ success: false, errors: { file: err.message } });
  }
  next();
};

module.exports = {
  upload,
  handleMulterError,
  submitRequest
};
