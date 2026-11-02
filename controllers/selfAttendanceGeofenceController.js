const pool = require("../config/db");
const logger = require("../utils/logger");
const { buildVisibilityScope } = require("../utils/selfAttendanceAccess");
const { getDistance } = require("../utils/geofencing");
const { ensureSelfAttendanceGeofenceSchema } = require("../utils/selfAttendanceGeofenceSchema");
const { ensureSelfAttendanceLeaveSchema } = require("../utils/selfAttendanceLeaveSchema");
const {
  getSelfAttendanceFeatureSettings,
  setSelfAttendanceGeofenceEnforcement,
} = require("../utils/selfAttendanceFeatureSettings");
const { sendPushToSelfAttendances } = require("../utils/selfAttendancePushService");
const { sendSms } = require("../utils/smsNotifier");

const DEFAULT_GEOFENCE_RADIUS_METERS = Math.max(
  25,
  Number(process.env.SELF_ATTENDANCE_GEOFENCE_RADIUS_METERS || 150)
);
const DEFAULT_DUPLICATE_RADIUS_METERS = Math.max(
  DEFAULT_GEOFENCE_RADIUS_METERS,
  Number(process.env.SELF_ATTENDANCE_GEOFENCE_DUPLICATE_RADIUS_METERS || 300)
);

const parseNumber = (value) => {
  if (value == null || typeof value === 'boolean' || typeof value === 'object' ||
      (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeSelfAttendanceScopeIds = async (scope = {}, clientRef = pool) => {
  const normalized = {
    city_id: scope.city_id || null,
    zone_id: scope.zone_id || null,
    ward_id: scope.ward_id || null,
    kothi_id: scope.kothi_id || null,
  };

  if (normalized.city_id) {
    const cityCheck = await clientRef.query(
      `SELECT city_id FROM cities WHERE city_id = $1 LIMIT 1`,
      [normalized.city_id]
    );
    if (cityCheck.rows.length === 0) normalized.city_id = null;
  }

  if (normalized.zone_id) {
    const zoneCheck = await clientRef.query(
      `SELECT zone_id FROM zones WHERE zone_id = $1 LIMIT 1`,
      [normalized.zone_id]
    );
    if (zoneCheck.rows.length === 0) normalized.zone_id = null;
  }

  if (normalized.ward_id) {
    const wardCheck = await clientRef.query(
      `SELECT sector_id FROM sectors WHERE sector_id = $1 LIMIT 1`,
      [normalized.ward_id]
    );
    if (wardCheck.rows.length === 0) normalized.ward_id = null;
  }

  if (normalized.kothi_id) {
    const kothiCheck = await clientRef.query(
      `SELECT ward_id FROM wards WHERE ward_id = $1 LIMIT 1`,
      [normalized.kothi_id]
    );
    if (kothiCheck.rows.length === 0) normalized.kothi_id = null;
  }

  return normalized;
};

const getSelfAttendanceScope = async (selfAttendanceId, clientRef = pool) => {
  const { rows } = await clientRef.query(
    `SELECT id, full_name, mobile, city_id, zone_id, ward_id, kothi_id
     FROM self_attendance_employees
     WHERE id = $1 AND is_active = TRUE
     LIMIT 1`,
    [selfAttendanceId]
  );
  return rows[0] || null;
};

const getActiveSelfAttendanceGeofences = async (selfAttendanceId, clientRef = pool) => {
  const { rows } = await clientRef.query(
    `SELECT *
     FROM self_attendance_geofences
     WHERE self_attendance_id = $1 AND is_active = TRUE
     ORDER BY approved_at DESC, created_at DESC`,
    [selfAttendanceId]
  );
  return rows;
};

const findNearestSelfAttendanceGeofence = (geofences = [], latitude, longitude) => {
  const currentLat = parseNumber(latitude);
  const currentLng = parseNumber(longitude);
  if (!Array.isArray(geofences) || geofences.length === 0 || currentLat == null || currentLng == null || Math.abs(currentLat)>90 || Math.abs(currentLng)>180) {
    return null;
  }

  let best = null;
  geofences.forEach((geofence) => {
    const distanceMeters = Math.round(
      getDistance(
        Number(geofence.latitude),
        Number(geofence.longitude),
        currentLat,
        currentLng
      )
    );
    if (!best || distanceMeters < best.distance_meters) {
      best = {
        geofence,
        distance_meters: distanceMeters,
        is_within: distanceMeters <= Number(geofence.radius_meters || DEFAULT_GEOFENCE_RADIUS_METERS),
      };
    }
  });

  return best;
};

const getLatestPendingSelfAttendanceGeofenceRequest = async (selfAttendanceId, clientRef = pool) => {
  const { rows } = await clientRef.query(
    `SELECT *
     FROM self_attendance_geofence_requests
     WHERE self_attendance_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [selfAttendanceId]
  );
  return rows[0] || null;
};

const buildStatusPayload = ({ activeGeofences = [], pendingRequest, latitude, longitude }) => {
  const nearestActive = findNearestSelfAttendanceGeofence(activeGeofences, latitude, longitude);
  const primaryGeofence = nearestActive?.geofence || activeGeofences[0] || null;
  const distanceMeters = nearestActive?.distance_meters ?? null;
  const isWithinApprovedGeofence = Boolean(nearestActive?.is_within);

  return {
    has_active_geofence: activeGeofences.length > 0,
    has_pending_request: Boolean(pendingRequest),
    active_geofence_count: activeGeofences.length,
    is_within_approved_geofence: activeGeofences.length > 0 ? isWithinApprovedGeofence : false,
    approved_radius_meters: primaryGeofence ? Number(primaryGeofence.radius_meters || DEFAULT_GEOFENCE_RADIUS_METERS) : null,
    approved_location: primaryGeofence
      ? {
          latitude: Number(primaryGeofence.latitude),
          longitude: Number(primaryGeofence.longitude),
          radius_meters: Number(primaryGeofence.radius_meters || DEFAULT_GEOFENCE_RADIUS_METERS),
          approved_at: primaryGeofence.approved_at,
        }
      : null,
    approved_locations: activeGeofences.map((geofence) => ({
      id: geofence.id,
      latitude: Number(geofence.latitude),
      longitude: Number(geofence.longitude),
      radius_meters: Number(geofence.radius_meters || DEFAULT_GEOFENCE_RADIUS_METERS),
      approved_at: geofence.approved_at,
      source_request_id: geofence.source_request_id || null,
    })),
    pending_request: pendingRequest
      ? {
          id: pendingRequest.id,
          status: pendingRequest.status,
          latitude: Number(pendingRequest.request_latitude),
          longitude: Number(pendingRequest.request_longitude),
          address: pendingRequest.request_address || null,
          created_at: pendingRequest.created_at,
        }
      : null,
    distance_from_approved_meters: distanceMeters,
  };
};

const createSelfAttendanceNotification = async ({
  selfAttendanceId,
  type,
  title,
  message,
  metadata,
  phone,
  smsMessage,
}) => {
  await ensureSelfAttendanceLeaveSchema();
  const { rows } = await pool.query(
    `INSERT INTO self_attendance_notifications (
      self_attendance_id, type, title, message, metadata
    )
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING *`,
    [
      selfAttendanceId,
      type,
      title,
      message,
      JSON.stringify(metadata || {}),
    ]
  );

  if (rows[0]) {
    try {
      await sendPushToSelfAttendances([rows[0]]);
    } catch (pushError) {
      logger.warn("[SelfAttendanceGeofence] Push notification failed:", pushError.message);
    }
  }

  const normalizedPhone = String(phone || "").replace(/\D/g, "");
  if (normalizedPhone.length === 10 && smsMessage) {
    try {
      await sendSms({
        phone: `+91${normalizedPhone}`,
        message: smsMessage,
        context: "general",
      });
    } catch (smsError) {
      logger.warn("[SelfAttendanceGeofence] SMS notification failed:", smsError.message);
    }
  }
};

const getMyGeofenceStatus = async (req, res) => {
  const selfAttendanceId = req.self_attendance?.self_attendance_id;
  const { latitude, longitude } = req.query;

  if (!selfAttendanceId) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }

  try {
    await ensureSelfAttendanceGeofenceSchema();
    const featureSettings = await getSelfAttendanceFeatureSettings();
    const geofenceEnforcementEnabled =
      featureSettings?.geofence_enforcement_enabled === true;

    const [profile, activeGeofence, pendingRequest] = await Promise.all([
      getSelfAttendanceScope(selfAttendanceId),
      getActiveSelfAttendanceGeofences(selfAttendanceId),
      getLatestPendingSelfAttendanceGeofenceRequest(selfAttendanceId),
    ]);

    if (!profile) {
      return res.status(404).json({ success: false, message: "Self Attendance profile not found." });
    }

    return res.json({
      success: true,
      data: {
        geofence_enforcement_enabled: geofenceEnforcementEnabled,
        ...buildStatusPayload({ activeGeofences: activeGeofence, pendingRequest, latitude, longitude }),
        self_attendance_scope: {
          city_id: profile.city_id || null,
          zone_id: profile.zone_id || null,
          ward_id: profile.ward_id || null,
          kothi_id: profile.kothi_id || null,
        },
      },
    });
  } catch (error) {
    logger.error("[SelfAttendanceGeofence] getMyGeofenceStatus error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch geofence status." });
  }
};

const submitSelfAttendanceGeofenceRequest = async (req, res) => {
  const selfAttendanceId = req.self_attendance?.self_attendance_id;
  const latitude = parseNumber(req.body?.latitude);
  const longitude = parseNumber(req.body?.longitude);
  const address = String(req.body?.address || "").trim() || null;
  const note = String(req.body?.note || "").trim() || null;
  const requestedRadius = parsePositiveInt(req.body?.radius_meters, DEFAULT_GEOFENCE_RADIUS_METERS);

  if (!selfAttendanceId) {
    return res.status(401).json({ success: false, message: "Unauthorized self_attendance session." });
  }
  if (latitude == null || longitude == null || Math.abs(latitude)>90 || Math.abs(longitude)>180) {
    return res.status(400).json({ success: false, message: "Valid latitude and longitude are required." });
  }

  const client = await pool.connect();
  try {
    await ensureSelfAttendanceGeofenceSchema();
    await client.query("BEGIN");

    const profile = await getSelfAttendanceScope(selfAttendanceId, client);
    if (!profile) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Self Attendance profile not found." });
    }
    const normalizedScope = await normalizeSelfAttendanceScopeIds(profile, client);

    const activeGeofences = await getActiveSelfAttendanceGeofences(selfAttendanceId, client);
    for (const activeGeofence of activeGeofences) {
      const approvedDistance = getDistance(
        Number(activeGeofence.latitude),
        Number(activeGeofence.longitude),
        latitude,
        longitude
      );
      if (approvedDistance <= DEFAULT_DUPLICATE_RADIUS_METERS) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          code: "ALREADY_APPROVED_NEARBY",
          message: "This location is already covered by your approved geo-fence.",
          distance_meters: Math.round(approvedDistance),
        });
      }
    }

    const pendingRows = await client.query(
      `SELECT id, request_latitude, request_longitude
       FROM self_attendance_geofence_requests
       WHERE self_attendance_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [selfAttendanceId]
    );

    for (const row of pendingRows.rows) {
      const pendingDistance = getDistance(
        Number(row.request_latitude),
        Number(row.request_longitude),
        latitude,
        longitude
      );
      if (pendingDistance <= DEFAULT_DUPLICATE_RADIUS_METERS) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          code: "PENDING_REQUEST_NEARBY",
          message: "A geo-fence request from this location is already pending review.",
          request_id: row.id,
          distance_meters: Math.round(pendingDistance),
        });
      }
    }

    const insertResult = await client.query(
      `INSERT INTO self_attendance_geofence_requests (
        self_attendance_id, city_id, zone_id, ward_id, kothi_id,
        request_latitude, request_longitude, request_address, request_note, request_radius_meters,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
      RETURNING *`,
      [
        selfAttendanceId,
        normalizedScope.city_id,
        normalizedScope.zone_id,
        normalizedScope.ward_id,
        normalizedScope.kothi_id,
        latitude,
        longitude,
        address,
        note,
        requestedRadius,
      ]
    );

    const requestRow = insertResult.rows[0];
    await client.query(
      `INSERT INTO self_attendance_geofence_request_logs (
        request_id, self_attendance_id, action, actor_type, note, metadata
      )
      VALUES ($1, $2, 'submitted', 'self_attendance', $3, $4::jsonb)`,
      [
        requestRow.id,
        selfAttendanceId,
        note,
        JSON.stringify({ latitude, longitude, address }),
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Self Attendance geofence request submitted.",
      data: requestRow,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[SelfAttendanceGeofence] submitSelfAttendanceGeofenceRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to submit geofence request." });
  } finally {
    client.release();
  }
};

const validateSelfAttendanceGeofenceAccess = async ({
  selfAttendanceId,
  latitude,
  longitude,
  clientRef = pool,
}) => {
  await ensureSelfAttendanceGeofenceSchema();
  const featureSettings = await getSelfAttendanceFeatureSettings(clientRef);

  if (featureSettings?.geofence_enforcement_enabled !== true) {
    return {
      allowed: true,
      bypassed: true,
      geofence_enforcement_enabled: false,
      code: "SELF_ATTENDANCE_GEOFENCE_DISABLED",
      message: "Self Attendance geo-fencing is currently disabled by admin.",
    };
  }

  const activeGeofences = await getActiveSelfAttendanceGeofences(selfAttendanceId, clientRef);
  const pendingRequest = await getLatestPendingSelfAttendanceGeofenceRequest(selfAttendanceId, clientRef);

  if (activeGeofences.length === 0) {
    return {
      allowed: false,
      geofence_enforcement_enabled: true,
      code: "SELF_ATTENDANCE_GEOFENCE_MISSING",
      message: "Go to your assigned location and request a new geo-fenced location if needed.",
      ...buildStatusPayload({ activeGeofences, pendingRequest, latitude, longitude }),
    };
  }

  const currentLat = parseNumber(latitude);
  const currentLng = parseNumber(longitude);
  if (currentLat == null || currentLng == null || Math.abs(currentLat)>90 || Math.abs(currentLng)>180) {
    return {
      allowed: false,
      geofence_enforcement_enabled: true,
      code: "SELF_ATTENDANCE_GEOFENCE_LOCATION_REQUIRED",
      message: "Location data is required to verify your assigned geo-fenced location.",
      ...buildStatusPayload({ activeGeofences, pendingRequest, latitude, longitude }),
    };
  }

  const nearestMatch = findNearestSelfAttendanceGeofence(activeGeofences, currentLat, currentLng);
  const distanceMeters = nearestMatch?.distance_meters ?? null;

  if (!nearestMatch?.is_within) {
    return {
      allowed: false,
      geofence_enforcement_enabled: true,
      code: "SELF_ATTENDANCE_GEOFENCE_OUTSIDE",
      message: "Go to any of your assigned locations. If this is a new work site, request a new geo-fenced location.",
      distance_meters: distanceMeters,
      ...buildStatusPayload({ activeGeofences, pendingRequest, latitude, longitude }),
    };
  }

  return {
    allowed: true,
    geofence_enforcement_enabled: true,
    distance_meters: distanceMeters,
    ...buildStatusPayload({ activeGeofences, pendingRequest, latitude, longitude }),
  };
};

const getSelfAttendanceGeofenceSettings = async (req, res) => {
  try {
    const settings = await getSelfAttendanceFeatureSettings();
    return res.json({
      success: true,
      data: {
        geofence_enforcement_enabled:
          settings?.geofence_enforcement_enabled === true,
        updated_by: settings?.updated_by || null,
        updated_at: settings?.updated_at || null,
      },
    });
  } catch (error) {
    logger.error("[SelfAttendanceGeofence] getSelfAttendanceGeofenceSettings error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch self_attendance geofence settings.",
    });
  }
};

const updateSelfAttendanceGeofenceSettings = async (req, res) => {
  try {
    const enabled = req.body?.geofence_enforcement_enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "geofence_enforcement_enabled must be boolean.",
      });
    }

    const updated = await setSelfAttendanceGeofenceEnforcement({
      enabled,
      updatedBy: req.user?.user_id || null,
    });

    return res.json({
      success: true,
      message: enabled
        ? "Self Attendance geofencing enabled."
        : "Self Attendance geofencing disabled.",
      data: {
        geofence_enforcement_enabled:
          updated?.geofence_enforcement_enabled === true,
        updated_by: updated?.updated_by || null,
        updated_at: updated?.updated_at || null,
      },
    });
  } catch (error) {
    logger.error("[SelfAttendanceGeofence] updateSelfAttendanceGeofenceSettings error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to update self_attendance geofence settings.",
    });
  }
};

const listSelfAttendanceGeofenceRequests = async (req, res) => {
  try {
    await ensureSelfAttendanceGeofenceSchema();
    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");
    const status = String(req.query?.status || "").trim().toLowerCase();

    let filters = `AND ${whereClause} AND pe.is_active = TRUE`;
    if (["pending", "approved", "rejected"].includes(status)) {
      params.push(status);
      filters += ` AND pgr.status = $${params.length}`;
    }

    const query = `
      ${cte}
      SELECT
        pgr.*,
        pe.full_name,
        pe.mobile,
        pe.email,
        reviewer.name AS reviewed_by_name,
        c.city_name,
        z.zone_name,
        s.sector_name AS ward_name,
        wk.ward_name AS kothi_name
      FROM self_attendance_geofence_requests pgr
      JOIN self_attendance_employees pe ON pe.id = pgr.self_attendance_id
      LEFT JOIN users reviewer ON reviewer.user_id = pgr.reviewed_by
      LEFT JOIN cities c ON pgr.city_id = c.city_id
      LEFT JOIN zones z ON pgr.zone_id = z.zone_id
      LEFT JOIN sectors s ON pgr.ward_id = s.sector_id
      LEFT JOIN wards wk ON pgr.kothi_id = wk.ward_id
      WHERE 1=1 ${filters}
      ORDER BY
        CASE WHEN pgr.status = 'pending' THEN 0 ELSE 1 END,
        pgr.created_at DESC
    `;

    const { rows } = await pool.query(query, params);
    return res.json({ success: true, data: rows });
  } catch (error) {
    logger.error("[SelfAttendanceGeofence] listSelfAttendanceGeofenceRequests error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch self_attendance geofence requests." });
  }
};

const reviewSelfAttendanceGeofenceRequest = async (req, res) => {
  const reviewerId = req.user?.user_id || req.user?.id || req.user?.userId;
  const { id } = req.params;
  const decision = String(req.body?.status || "").trim().toLowerCase();
  const note = String(req.body?.reason || req.body?.note || "").trim();
  const requestedRadius = parsePositiveInt(req.body?.radius_meters, DEFAULT_GEOFENCE_RADIUS_METERS);

  if (!reviewerId) {
    return res.status(401).json({ success: false, message: "Unauthorized reviewer context." });
  }
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ success: false, message: "Status must be approved or rejected." });
  }
  if (decision === "rejected" && !note) {
    return res.status(400).json({ success: false, message: "Rejection reason is required." });
  }

  const client = await pool.connect();
  try {
    await ensureSelfAttendanceGeofenceSchema();
    await client.query("BEGIN");

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");
    const scopedParams = [...params, id];
    const scopedQuery = `
      ${cte}
      SELECT
        pgr.*,
        pe.full_name,
        pe.mobile,
        pe.email
      FROM self_attendance_geofence_requests pgr
      JOIN self_attendance_employees pe ON pe.id = pgr.self_attendance_id
      WHERE pgr.id = $${scopedParams.length}
        AND pe.is_active = TRUE
        AND ${whereClause}
      FOR UPDATE
    `;
    const scopedResult = await client.query(scopedQuery, scopedParams);
    if (scopedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Self Attendance geofence request not found or access denied." });
    }

    const requestRow = scopedResult.rows[0];
    if (requestRow.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: `Request already ${requestRow.status}.` });
    }

    let approvedGeofenceId = null;
    if (decision === "approved") {
      const requestLat=parseNumber(requestRow.request_latitude),requestLng=parseNumber(requestRow.request_longitude);
      if(requestLat==null||requestLng==null||Math.abs(requestLat)>90||Math.abs(requestLng)>180){
        await client.query('ROLLBACK');
        return res.status(400).json({success:false,message:'Requested coordinates are invalid. Submit a new location request.'});
      }
      const geofenceInsert = await client.query(
        `INSERT INTO self_attendance_geofences (
          self_attendance_id, city_id, zone_id, ward_id, kothi_id,
          latitude, longitude, radius_meters, source_request_id, approved_by, approved_at, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), TRUE)
        RETURNING id`,
        [
          requestRow.self_attendance_id,
          ...(await (async () => {
            const normalizedScope = await normalizeSelfAttendanceScopeIds(requestRow, client);
            return [
              normalizedScope.city_id,
              normalizedScope.zone_id,
              normalizedScope.ward_id,
              normalizedScope.kothi_id,
            ];
          })()),
          Number(requestRow.request_latitude),
          Number(requestRow.request_longitude),
          requestedRadius,
          requestRow.id,
          reviewerId,
        ]
      );
      approvedGeofenceId = geofenceInsert.rows[0]?.id || null;
    }

    const updateResult = await client.query(
      `UPDATE self_attendance_geofence_requests
       SET status = $1,
           rejection_reason = $2,
           reviewed_by = $3,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [
        decision,
        decision === "rejected" ? note : null,
        reviewerId,
        id,
      ]
    );

    await client.query(
      `INSERT INTO self_attendance_geofence_request_logs (
        request_id, self_attendance_id, action, actor_type, actor_user_id, note, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        id,
        requestRow.self_attendance_id,
        decision,
        String(req.user?.role || "").toLowerCase() === "admin" ? "admin" : "supervisor",
        reviewerId,
        note || null,
        JSON.stringify({
          approved_geofence_id: approvedGeofenceId,
          radius_meters: decision === "approved" ? requestedRadius : null,
        }),
      ]
    );

    await client.query("COMMIT");

    const title =
      decision === "approved"
        ? "Geo-fenced location approved"
        : "Geo-fenced location rejected";
    const message =
      decision === "approved"
        ? "Your new geo-fenced location has been approved. You can punch from this assigned location now."
        : `Your geo-fenced location request was rejected.${note ? ` Reason: ${note}` : " Please reapply from the correct work location."}`;

    await createSelfAttendanceNotification({
      selfAttendanceId: requestRow.self_attendance_id,
      type: "self-attendance-geofence-review",
      title,
      message,
      metadata: {
        request_id: id,
        status: decision,
        reason: decision === "rejected" ? note : null,
        approved_geofence_id: approvedGeofenceId,
      },
      phone: requestRow.mobile,
      smsMessage: message,
    });

    return res.json({
      success: true,
      message: decision === "approved" ? "Self Attendance geofence request approved." : "Self Attendance geofence request rejected.",
      data: updateResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[SelfAttendanceGeofence] reviewSelfAttendanceGeofenceRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to review self_attendance geofence request." });
  } finally {
    client.release();
  }
};

const updateSelfAttendanceGeofenceRadius = async (req, res) => {
  const reviewerId = req.user?.user_id || req.user?.id || req.user?.userId;
  const { id } = req.params;
  const rawRadius = parseInt(req.body?.radius_meters, 10);

  if (!reviewerId) {
    return res.status(401).json({ success: false, message: "Unauthorized reviewer context." });
  }
  if (!Number.isInteger(rawRadius) || rawRadius < 25 || rawRadius > 1000) {
    return res.status(400).json({
      success: false,
      message: "Radius must be an integer between 25 and 1000 meters.",
    });
  }

  const client = await pool.connect();
  try {
    await ensureSelfAttendanceGeofenceSchema();
    await client.query("BEGIN");

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");
    const scopedParams = [...params, id];
    const scopedQuery = `
      ${cte}
      SELECT
        pgr.*,
        pe.full_name
      FROM self_attendance_geofence_requests pgr
      JOIN self_attendance_employees pe ON pe.id = pgr.self_attendance_id
      WHERE pgr.id = $${scopedParams.length}
        AND pe.is_active = TRUE
        AND ${whereClause}
      FOR UPDATE
    `;
    const scopedResult = await client.query(scopedQuery, scopedParams);
    if (scopedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Self Attendance geofence request not found or access denied.",
      });
    }

    const requestRow = scopedResult.rows[0];
    const updatedRequestResult = await client.query(
      `UPDATE self_attendance_geofence_requests
       SET request_radius_meters = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [rawRadius, id]
    );

    if (requestRow.status === "approved") {
      await client.query(
        `UPDATE self_attendance_geofences
         SET radius_meters = $1,
             updated_at = NOW()
         WHERE source_request_id = $2`,
        [rawRadius, id]
      );
    }

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Self Attendance geofence radius updated.",
      data: updatedRequestResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[SelfAttendanceGeofence] updateSelfAttendanceGeofenceRadius error:", error);
    return res.status(500).json({ success: false, message: "Unable to update self_attendance geofence radius." });
  } finally {
    client.release();
  }
};

const deleteSelfAttendanceGeofenceRequest = async (req, res) => {
  const actorId = req.user?.user_id || req.user?.id || req.user?.userId;
  const { id } = req.params;

  if (!actorId) {
    return res.status(401).json({ success: false, message: "Unauthorized reviewer context." });
  }

  const client = await pool.connect();
  try {
    await ensureSelfAttendanceGeofenceSchema();
    await client.query("BEGIN");

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");
    const scopedParams = [...params, id];
    const scopedQuery = `
      ${cte}
      SELECT
        pgr.*,
        pe.full_name,
        pe.mobile,
        pe.email
      FROM self_attendance_geofence_requests pgr
      JOIN self_attendance_employees pe ON pe.id = pgr.self_attendance_id
      WHERE pgr.id = $${scopedParams.length}
        AND pe.is_active = TRUE
        AND ${whereClause}
      FOR UPDATE
    `;
    const scopedResult = await client.query(scopedQuery, scopedParams);
    if (scopedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Self Attendance geofence request not found or access denied.",
      });
    }

    const requestRow = scopedResult.rows[0];

    if (requestRow.status === "approved") {
      await client.query(
        `UPDATE self_attendance_geofences
         SET is_active = FALSE,
             updated_at = NOW()
         WHERE source_request_id = $1`,
        [id]
      );
    }

    await client.query(
      `INSERT INTO self_attendance_geofence_request_logs (
        request_id, self_attendance_id, action, actor_type, actor_user_id, note, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        id,
        requestRow.self_attendance_id,
        "deleted",
        String(req.user?.role || "").toLowerCase() === "admin" ? "admin" : "supervisor",
        actorId,
        "Request deleted by reviewer",
        JSON.stringify({
          deleted_status: requestRow.status,
          request_radius_meters: requestRow.request_radius_meters || null,
        }),
      ]
    );

    await client.query(
      `DELETE FROM self_attendance_geofence_requests
       WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        requestRow.status === "approved"
          ? "Approved self_attendance geofence request deleted and linked geofence deactivated."
          : "Self Attendance geofence request deleted successfully.",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[SelfAttendanceGeofence] deleteSelfAttendanceGeofenceRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete self_attendance geofence request." });
  } finally {
    client.release();
  }
};

module.exports = {
  getMyGeofenceStatus,
  submitSelfAttendanceGeofenceRequest,
  validateSelfAttendanceGeofenceAccess,
  getSelfAttendanceGeofenceSettings,
  updateSelfAttendanceGeofenceSettings,
  listSelfAttendanceGeofenceRequests,
  reviewSelfAttendanceGeofenceRequest,
  updateSelfAttendanceGeofenceRadius,
  deleteSelfAttendanceGeofenceRequest,
};
