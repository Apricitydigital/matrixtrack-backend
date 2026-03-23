const pool = require("../config/db");

const zoneAccessCache = new Map();
let zoneAccessVersion = 0;

const buildCacheKey = (userId) => `${userId || "unknown"}:${zoneAccessVersion}`;

const invalidateZoneAccessCache = () => {
  zoneAccessVersion += 1;
  zoneAccessCache.clear();
};

const normalizeZoneIds = (zoneIds = []) => {
  const seen = new Set();
  const normalized = [];

  (zoneIds || []).forEach((raw) => {
    const value = Number(raw);
    if (Number.isFinite(value) && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  });

  return normalized;
};

const fetchUserZoneAccess = async (user, options = {}) => {
  const userId =
    (typeof user === "object" && user !== null ? user.user_id : null) ||
    Number(user) ||
    null;
  const includeZoneMetadata = options.includeZones || options.withNames;

  if (!userId) {
    return { ids: [], zones: [] };
  }

  const cacheKey = buildCacheKey(userId);
  if (!includeZoneMetadata && zoneAccessCache.has(cacheKey)) {
    return zoneAccessCache.get(cacheKey);
  }

  const queryText = includeZoneMetadata
    ? `
        SELECT z.zone_id, z.zone_name, z.city_id, c.city_name
        FROM zones z
        JOIN cities c ON c.city_id = z.city_id
        WHERE z.zone_id IN (SELECT zone_id FROM user_zone_access WHERE user_id = $1)
           OR z.city_id IN (SELECT city_id FROM user_city_access WHERE user_id = $1)
        ORDER BY z.zone_name ASC
      `
    : `
        SELECT zone_id FROM user_zone_access WHERE user_id = $1
        UNION
        SELECT zone_id FROM zones WHERE city_id IN (SELECT city_id FROM user_city_access WHERE user_id = $1)
      `;

  const { rows } = await pool.query(queryText, [userId]);
  const ids = normalizeZoneIds(
    includeZoneMetadata
      ? rows.map((row) => row.zone_id)
      : rows.map((row) => row.zone_id)
  );

  const payload = includeZoneMetadata
    ? {
        ids,
        zones: rows.map((row) => ({
          zone_id: row.zone_id,
          zone_name: row.zone_name,
          city_id: row.city_id,
          city_name: row.city_name,
        })),
      }
    : { ids };

  if (!includeZoneMetadata) {
    zoneAccessCache.set(cacheKey, payload);
  }

  return payload;
};

const syncUserZoneAccess = async (
  userId,
  zoneIds = [],
  actorId = null,
  client = pool
) => {
  const ids = normalizeZoneIds(zoneIds);

  await client.query("DELETE FROM user_zone_access WHERE user_id = $1", [
    userId,
  ]);

  if (ids.length === 0) {
    invalidateZoneAccessCache();
    return;
  }

  await client.query(
    `
      INSERT INTO user_zone_access (user_id, zone_id, granted_at, granted_by)
      SELECT $1, UNNEST($2::int[]), NOW(), $3
      ON CONFLICT DO NOTHING
    `,
    [userId, ids, actorId ?? null]
  );

  invalidateZoneAccessCache();
};

module.exports = {
  fetchUserZoneAccess,
  normalizeZoneIds,
  syncUserZoneAccess,
  invalidateZoneAccessCache,
};
