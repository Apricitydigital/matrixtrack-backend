const pool = require("../config/db");
const { invalidateKothiAccessCache } = require("./userKothiAccess");

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
  const allowCityFallback =
    options.allowCityFallback === undefined
      ? true
      : Boolean(options.allowCityFallback);

  if (!userId) {
    return { ids: [], zones: [] };
  }

  const cacheKey = buildCacheKey(userId);
  if (!includeZoneMetadata && zoneAccessCache.has(cacheKey)) {
    return zoneAccessCache.get(cacheKey);
  }

  // 1) Direct zone assignments
  const directZoneRows = await pool.query(
    "SELECT zone_id FROM user_zone_access WHERE user_id = $1",
    [userId]
  );
  let zoneIds = normalizeZoneIds(directZoneRows.rows.map((row) => row.zone_id));

  // 2) Derive from ward/kothi assignments if no direct zones
  if (zoneIds.length === 0) {
    const derivedZoneRows = await pool.query(
      `
        SELECT DISTINCT COALESCE(w.zone_id, s.zone_id) AS zone_id
        FROM (
          SELECT ward_id FROM user_kothi_access WHERE user_id = $1
          UNION
          SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
          UNION
          SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1
          UNION
          -- Legacy fallback: only treat supervisor_ward.ward_id as sector_id
          -- when that value does not exist as a real ward_id.
          SELECT w.ward_id
          FROM supervisor_ward sw_legacy
          LEFT JOIN wards w_direct ON w_direct.ward_id = sw_legacy.ward_id
          JOIN wards w ON w.sector_id = sw_legacy.ward_id
          WHERE sw_legacy.supervisor_id = $1
            AND w_direct.ward_id IS NULL
        ) k
        JOIN wards w ON w.ward_id = k.ward_id
        LEFT JOIN sectors s ON s.sector_id = w.sector_id
        WHERE COALESCE(w.zone_id, s.zone_id) IS NOT NULL
      `,
      [userId]
    );
    zoneIds = normalizeZoneIds(derivedZoneRows.rows.map((row) => row.zone_id));
  }

  // 3) Fallback to city -> zones only when no explicit zones found
  if (zoneIds.length === 0 && allowCityFallback) {
    const cityRows = await pool.query(
      "SELECT city_id FROM user_city_access WHERE user_id = $1",
      [userId]
    );
    const cityIds = cityRows.rows
      .map((row) => Number(row.city_id))
      .filter((id) => Number.isFinite(id));

    if (cityIds.length > 0) {
      const zonesFromCities = await pool.query(
        `
          SELECT z.zone_id, z.zone_name, z.city_id, c.city_name
          FROM zones z
          JOIN cities c ON c.city_id = z.city_id
          WHERE z.city_id = ANY($1)
        `,
        [cityIds]
      );
      zoneIds = normalizeZoneIds(
        zonesFromCities.rows.map((row) => row.zone_id)
      );

      if (includeZoneMetadata) {
        // reuse fetched metadata to avoid another query
        const payload = {
          ids: zoneIds,
          zones: zonesFromCities.rows.map((row) => ({
            zone_id: row.zone_id,
            zone_name: row.zone_name,
            city_id: row.city_id,
            city_name: row.city_name,
          })),
        };
        return payload;
      }
    }
  }

  if (includeZoneMetadata) {
    if (zoneIds.length === 0) {
      return { ids: [], zones: [] };
    }
    const { rows } = await pool.query(
      `
        SELECT z.zone_id, z.zone_name, z.city_id, c.city_name
        FROM zones z
        JOIN cities c ON c.city_id = z.city_id
        WHERE z.zone_id = ANY($1)
        ORDER BY z.zone_name ASC
      `,
      [zoneIds]
    );

    return {
      ids: normalizeZoneIds(rows.map((row) => row.zone_id)),
      zones: rows.map((row) => ({
        zone_id: row.zone_id,
        zone_name: row.zone_name,
        city_id: row.city_id,
        city_name: row.city_name,
      })),
    };
  }

  const payload = { ids: zoneIds };
  zoneAccessCache.set(cacheKey, payload);
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
    invalidateKothiAccessCache(); // zone changes alter derived kothi scopes
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
  invalidateKothiAccessCache(); // keep kothi scope cache in sync when zones change
};


module.exports = {
  fetchUserZoneAccess,
  normalizeZoneIds,
  syncUserZoneAccess,
  invalidateZoneAccessCache,
};
