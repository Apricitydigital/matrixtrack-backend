const pool = require("../config/db");
const logger = require("../utils/logger");
const { buildVisibilityScope } = require("../utils/professionalAccess");
const { getDistance } = require("../utils/geofencing");
const { ensureProfessionalGeofenceSchema } = require("../utils/professionalGeofenceSchema");
const { ensureProfessionalLeaveSchema } = require("../utils/professionalLeaveSchema");
const {
  getProfessionalFeatureSettings,
  setProfessionalGeofenceEnforcement,
} = require("../utils/professionalFeatureSettings");
const { sendPushToProfessionals } = require("../utils/professionalPushService");
const { sendSms } = require("../utils/smsNotifier");

const DEFAULT_GEOFENCE_RADIUS_METERS = Math.max(
  25,
  Number(process.env.PROFESSIONAL_GEOFENCE_RADIUS_METERS || 150)
);
const DEFAULT_DUPLICATE_RADIUS_METERS = Math.max(
  DEFAULT_GEOFENCE_RADIUS_METERS,
  Number(process.env.PROFESSIONAL_GEOFENCE_DUPLICATE_RADIUS_METERS || 300)
);

const parseNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeProfessionalScopeIds = async (scope = {}, clientRef = pool) => {
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

const getProfessionalScope = async (professionalId, clientRef = pool) => {
  const { rows } = await clientRef.query(
    `SELECT id, full_name, mobile, city_id, zone_id, ward_id, kothi_id
     FROM professional_employees
     WHERE id = $1 AND is_active = TRUE
     LIMIT 1`,
    [professionalId]
  );
  return rows[0] || null;
};

const getActiveProfessionalGeofences = async (professionalId, clientRef = pool) => {
  const { rows } = await clientRef.query(
    `SELECT *
     FROM professional_geofences
     WHERE professional_id = $1 AND is_active = TRUE
     ORDER BY approved_at DESC, created_at DESC`,
    [professionalId]
  );
  return rows;
};

const findNearestProfessionalGeofence = (geofences = [], latitude, longitude) => {
  const currentLat = parseNumber(latitude);
  const currentLng = parseNumber(longitude);
  if (!Array.isArray(geofences) || geofences.length === 0 || currentLat == null || currentLng == null) {
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

const getLatestPendingProfessionalGeofenceRequest = async (professionalId, clientRef = pool) => {
  const { rows } = await clientRef.query(
    `SELECT *
     FROM professional_geofence_requests
     WHERE professional_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [professionalId]
  );
  return rows[0] || null;
};

const buildStatusPayload = ({ activeGeofences = [], pendingRequest, latitude, longitude }) => {
  const nearestActive = findNearestProfessionalGeofence(activeGeofences, latitude, longitude);
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

const createProfessionalNotification = async ({
  professionalId,
  type,
  title,
  message,
  metadata,
  phone,
  smsMessage,
}) => {
  await ensureProfessionalLeaveSchema();
  const { rows } = await pool.query(
    `INSERT INTO professional_notifications (
      professional_id, type, title, message, metadata
    )
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING *`,
    [
      professionalId,
      type,
      title,
      message,
      JSON.stringify(metadata || {}),
    ]
  );

  if (rows[0]) {
    try {
      await sendPushToProfessionals([rows[0]]);
    } catch (pushError) {
      logger.warn("[ProfessionalGeofence] Push notification failed:", pushError.message);
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
      logger.warn("[ProfessionalGeofence] SMS notification failed:", smsError.message);
    }
  }
};

const getMyGeofenceStatus = async (req, res) => {
  const professionalId = req.professional?.professional_id;
  const { latitude, longitude } = req.query;

  if (!professionalId) {
    return res.status(401).json({ success: false, message: "Unauthorized professional session." });
  }

  try {
    await ensureProfessionalGeofenceSchema();
    const featureSettings = await getProfessionalFeatureSettings();
    const geofenceEnforcementEnabled =
      featureSettings?.geofence_enforcement_enabled === true;

    const [profile, activeGeofence, pendingRequest] = await Promise.all([
      getProfessionalScope(professionalId),
      getActiveProfessionalGeofences(professionalId),
      getLatestPendingProfessionalGeofenceRequest(professionalId),
    ]);

    if (!profile) {
      return res.status(404).json({ success: false, message: "Professional profile not found." });
    }

    return res.json({
      success: true,
      data: {
        geofence_enforcement_enabled: geofenceEnforcementEnabled,
        ...buildStatusPayload({ activeGeofences: activeGeofence, pendingRequest, latitude, longitude }),
        professional_scope: {
          city_id: profile.city_id || null,
          zone_id: profile.zone_id || null,
          ward_id: profile.ward_id || null,
          kothi_id: profile.kothi_id || null,
        },
      },
    });
  } catch (error) {
    logger.error("[ProfessionalGeofence] getMyGeofenceStatus error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch geofence status." });
  }
};

const submitProfessionalGeofenceRequest = async (req, res) => {
  const professionalId = req.professional?.professional_id;
  const latitude = parseNumber(req.body?.latitude);
  const longitude = parseNumber(req.body?.longitude);
  const address = String(req.body?.address || "").trim() || null;
  const note = String(req.body?.note || "").trim() || null;
  const requestedRadius = parsePositiveInt(req.body?.radius_meters, DEFAULT_GEOFENCE_RADIUS_METERS);

  if (!professionalId) {
    return res.status(401).json({ success: false, message: "Unauthorized professional session." });
  }
  if (latitude == null || longitude == null) {
    return res.status(400).json({ success: false, message: "Latitude and longitude are required." });
  }

  const client = await pool.connect();
  try {
    await ensureProfessionalGeofenceSchema();
    await client.query("BEGIN");

    const profile = await getProfessionalScope(professionalId, client);
    if (!profile) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Professional profile not found." });
    }
    const normalizedScope = await normalizeProfessionalScopeIds(profile, client);

    const activeGeofences = await getActiveProfessionalGeofences(professionalId, client);
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
       FROM professional_geofence_requests
       WHERE professional_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [professionalId]
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
      `INSERT INTO professional_geofence_requests (
        professional_id, city_id, zone_id, ward_id, kothi_id,
        request_latitude, request_longitude, request_address, request_note, request_radius_meters,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
      RETURNING *`,
      [
        professionalId,
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
      `INSERT INTO professional_geofence_request_logs (
        request_id, professional_id, action, actor_type, note, metadata
      )
      VALUES ($1, $2, 'submitted', 'professional', $3, $4::jsonb)`,
      [
        requestRow.id,
        professionalId,
        note,
        JSON.stringify({ latitude, longitude, address }),
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Professional geofence request submitted.",
      data: requestRow,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[ProfessionalGeofence] submitProfessionalGeofenceRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to submit geofence request." });
  } finally {
    client.release();
  }
};

const validateProfessionalGeofenceAccess = async ({
  professionalId,
  latitude,
  longitude,
  clientRef = pool,
}) => {
  await ensureProfessionalGeofenceSchema();
  const featureSettings = await getProfessionalFeatureSettings(clientRef);

  if (featureSettings?.geofence_enforcement_enabled !== true) {
    return {
      allowed: true,
      bypassed: true,
      geofence_enforcement_enabled: false,
      code: "PROFESSIONAL_GEOFENCE_DISABLED",
      message: "Professional geo-fencing is currently disabled by admin.",
    };
  }

  const activeGeofences = await getActiveProfessionalGeofences(professionalId, clientRef);
  const pendingRequest = await getLatestPendingProfessionalGeofenceRequest(professionalId, clientRef);

  if (activeGeofences.length === 0) {
    return {
      allowed: false,
      geofence_enforcement_enabled: true,
      code: "PROFESSIONAL_GEOFENCE_MISSING",
      message: "Go to your assigned location and request a new geo-fenced location if needed.",
      ...buildStatusPayload({ activeGeofences, pendingRequest, latitude, longitude }),
    };
  }

  const currentLat = parseNumber(latitude);
  const currentLng = parseNumber(longitude);
  if (currentLat == null || currentLng == null) {
    return {
      allowed: false,
      geofence_enforcement_enabled: true,
      code: "PROFESSIONAL_GEOFENCE_LOCATION_REQUIRED",
      message: "Location data is required to verify your assigned geo-fenced location.",
      ...buildStatusPayload({ activeGeofences, pendingRequest, latitude, longitude }),
    };
  }

  const nearestMatch = findNearestProfessionalGeofence(activeGeofences, currentLat, currentLng);
  const distanceMeters = nearestMatch?.distance_meters ?? null;

  if (!nearestMatch?.is_within) {
    return {
      allowed: false,
      geofence_enforcement_enabled: true,
      code: "PROFESSIONAL_GEOFENCE_OUTSIDE",
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

const getProfessionalGeofenceSettings = async (req, res) => {
  try {
    const settings = await getProfessionalFeatureSettings();
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
    logger.error("[ProfessionalGeofence] getProfessionalGeofenceSettings error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch professional geofence settings.",
    });
  }
};

const updateProfessionalGeofenceSettings = async (req, res) => {
  try {
    const enabled = req.body?.geofence_enforcement_enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "geofence_enforcement_enabled must be boolean.",
      });
    }

    const updated = await setProfessionalGeofenceEnforcement({
      enabled,
      updatedBy: req.user?.user_id || null,
    });

    return res.json({
      success: true,
      message: enabled
        ? "Professional geofencing enabled."
        : "Professional geofencing disabled.",
      data: {
        geofence_enforcement_enabled:
          updated?.geofence_enforcement_enabled === true,
        updated_by: updated?.updated_by || null,
        updated_at: updated?.updated_at || null,
      },
    });
  } catch (error) {
    logger.error("[ProfessionalGeofence] updateProfessionalGeofenceSettings error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to update professional geofence settings.",
    });
  }
};

const listProfessionalGeofenceRequests = async (req, res) => {
  try {
    await ensureProfessionalGeofenceSchema();
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
      FROM professional_geofence_requests pgr
      JOIN professional_employees pe ON pe.id = pgr.professional_id
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
    logger.error("[ProfessionalGeofence] listProfessionalGeofenceRequests error:", error);
    return res.status(500).json({ success: false, message: "Unable to fetch professional geofence requests." });
  }
};

const reviewProfessionalGeofenceRequest = async (req, res) => {
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
    await ensureProfessionalGeofenceSchema();
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
      FROM professional_geofence_requests pgr
      JOIN professional_employees pe ON pe.id = pgr.professional_id
      WHERE pgr.id = $${scopedParams.length}
        AND pe.is_active = TRUE
        AND ${whereClause}
      FOR UPDATE
    `;
    const scopedResult = await client.query(scopedQuery, scopedParams);
    if (scopedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Professional geofence request not found or access denied." });
    }

    const requestRow = scopedResult.rows[0];
    if (requestRow.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: `Request already ${requestRow.status}.` });
    }

    let approvedGeofenceId = null;
    if (decision === "approved") {
      const geofenceInsert = await client.query(
        `INSERT INTO professional_geofences (
          professional_id, city_id, zone_id, ward_id, kothi_id,
          latitude, longitude, radius_meters, source_request_id, approved_by, approved_at, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), TRUE)
        RETURNING id`,
        [
          requestRow.professional_id,
          ...(await (async () => {
            const normalizedScope = await normalizeProfessionalScopeIds(requestRow, client);
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
      `UPDATE professional_geofence_requests
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
      `INSERT INTO professional_geofence_request_logs (
        request_id, professional_id, action, actor_type, actor_user_id, note, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        id,
        requestRow.professional_id,
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

    await createProfessionalNotification({
      professionalId: requestRow.professional_id,
      type: "professional-geofence-review",
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
      message: decision === "approved" ? "Professional geofence request approved." : "Professional geofence request rejected.",
      data: updateResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[ProfessionalGeofence] reviewProfessionalGeofenceRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to review professional geofence request." });
  } finally {
    client.release();
  }
};

const updateProfessionalGeofenceRadius = async (req, res) => {
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
    await ensureProfessionalGeofenceSchema();
    await client.query("BEGIN");

    const { cte, whereClause, params } = buildVisibilityScope(req.user, req.cityScope, "pe");
    const scopedParams = [...params, id];
    const scopedQuery = `
      ${cte}
      SELECT
        pgr.*,
        pe.full_name
      FROM professional_geofence_requests pgr
      JOIN professional_employees pe ON pe.id = pgr.professional_id
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
        message: "Professional geofence request not found or access denied.",
      });
    }

    const requestRow = scopedResult.rows[0];
    const updatedRequestResult = await client.query(
      `UPDATE professional_geofence_requests
       SET request_radius_meters = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [rawRadius, id]
    );

    if (requestRow.status === "approved") {
      await client.query(
        `UPDATE professional_geofences
         SET radius_meters = $1,
             updated_at = NOW()
         WHERE source_request_id = $2`,
        [rawRadius, id]
      );
    }

    await client.query("COMMIT");
    return res.json({
      success: true,
      message: "Professional geofence radius updated.",
      data: updatedRequestResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[ProfessionalGeofence] updateProfessionalGeofenceRadius error:", error);
    return res.status(500).json({ success: false, message: "Unable to update professional geofence radius." });
  } finally {
    client.release();
  }
};

const deleteProfessionalGeofenceRequest = async (req, res) => {
  const actorId = req.user?.user_id || req.user?.id || req.user?.userId;
  const { id } = req.params;

  if (!actorId) {
    return res.status(401).json({ success: false, message: "Unauthorized reviewer context." });
  }

  const client = await pool.connect();
  try {
    await ensureProfessionalGeofenceSchema();
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
      FROM professional_geofence_requests pgr
      JOIN professional_employees pe ON pe.id = pgr.professional_id
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
        message: "Professional geofence request not found or access denied.",
      });
    }

    const requestRow = scopedResult.rows[0];

    if (requestRow.status === "approved") {
      await client.query(
        `UPDATE professional_geofences
         SET is_active = FALSE,
             updated_at = NOW()
         WHERE source_request_id = $1`,
        [id]
      );
    }

    await client.query(
      `INSERT INTO professional_geofence_request_logs (
        request_id, professional_id, action, actor_type, actor_user_id, note, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        id,
        requestRow.professional_id,
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
      `DELETE FROM professional_geofence_requests
       WHERE id = $1`,
      [id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message:
        requestRow.status === "approved"
          ? "Approved professional geofence request deleted and linked geofence deactivated."
          : "Professional geofence request deleted successfully.",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error("[ProfessionalGeofence] deleteProfessionalGeofenceRequest error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete professional geofence request." });
  } finally {
    client.release();
  }
};

module.exports = {
  getMyGeofenceStatus,
  submitProfessionalGeofenceRequest,
  validateProfessionalGeofenceAccess,
  getProfessionalGeofenceSettings,
  updateProfessionalGeofenceSettings,
  listProfessionalGeofenceRequests,
  reviewProfessionalGeofenceRequest,
  updateProfessionalGeofenceRadius,
  deleteProfessionalGeofenceRequest,
};
