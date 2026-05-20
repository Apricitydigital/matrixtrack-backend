const pool = require("../config/db");

const kothiAccessCache = new Map();
let kothiAccessVersion = 0;

const buildCacheKey = (userId) => `${userId || "unknown"}:${kothiAccessVersion}`;

const invalidateKothiAccessCache = () => {
  kothiAccessVersion += 1;
  kothiAccessCache.clear();
};

const normalizeWardIds = (wardIds = []) => {
  const seen = new Set();
  const normalized = [];

  (wardIds || []).forEach((raw) => {
    const value = Number(raw);
    if (Number.isFinite(value) && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  });

  return normalized;
};

const fetchUserKothiAccess = async (user, options = {}) => {
  const userId =
    (typeof user === "object" && user !== null ? user.user_id : null) ||
    Number(user) ||
    null;
  const includeMetadata = options.includeKothis || options.withNames;
  const allowZoneFallback =
    options.allowZoneFallback === undefined
      ? true
      : Boolean(options.allowZoneFallback);
  const allowCityFallback =
    options.allowCityFallback === undefined
      ? true
      : Boolean(options.allowCityFallback);

  if (!userId) {
    return { ids: [], kothis: [] };
  }

  const cacheKey = buildCacheKey(userId);
  if (!includeMetadata && kothiAccessCache.has(cacheKey)) {
    return kothiAccessCache.get(cacheKey);
  }

  // 1) Direct Kothi assignments (user + legacy supervisor mappings)
  const directRows = await pool.query(
    `
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
    `,
    [userId]
  );
  let wardIds = normalizeWardIds(directRows.rows.map((row) => row.ward_id));

  // 2) Fallback to zones -> wards if nothing explicit
  if (wardIds.length === 0 && allowZoneFallback) {
    const zoneRows = await pool.query(
      "SELECT zone_id FROM user_zone_access WHERE user_id = $1",
      [userId]
    );
    const zoneIds = zoneRows.rows
      .map((row) => Number(row.zone_id))
      .filter((id) => Number.isFinite(id));

    if (zoneIds.length > 0) {
      const zoneWardRows = await pool.query(
        "SELECT ward_id FROM wards WHERE zone_id = ANY($1)",
        [zoneIds]
      );
      wardIds = normalizeWardIds(zoneWardRows.rows.map((row) => row.ward_id));
    }
  }

  // 3) Fallback to city -> wards only when no zone/ward assignments
  if (wardIds.length === 0 && allowCityFallback) {
    const cityRows = await pool.query(
      "SELECT city_id FROM user_city_access WHERE user_id = $1",
      [userId]
    );
    const cityIds = cityRows.rows
      .map((row) => Number(row.city_id))
      .filter((id) => Number.isFinite(id));

    if (cityIds.length > 0) {
      const cityWardRows = await pool.query(
        `
          SELECT w.ward_id
          FROM wards w
          JOIN zones z ON z.zone_id = w.zone_id
          WHERE z.city_id = ANY($1)
        `,
        [cityIds]
      );
      wardIds = normalizeWardIds(cityWardRows.rows.map((row) => row.ward_id));
    }
  }

  if (includeMetadata) {
    if (wardIds.length === 0) {
      return { ids: [], kothis: [] };
    }

    const { rows } = await pool.query(
      `
        SELECT w.ward_id,
               w.ward_name,
               s.sector_id,
               s.sector_name,
               z.zone_id,
               z.zone_name,
               c.city_id,
               c.city_name
        FROM wards w
        LEFT JOIN sectors s ON s.sector_id = w.sector_id
        LEFT JOIN zones z ON z.zone_id = COALESCE(s.zone_id, w.zone_id)
        LEFT JOIN cities c ON c.city_id = z.city_id
        WHERE w.ward_id = ANY($1)
        ORDER BY w.ward_name ASC
      `,
      [wardIds]
    );

    return {
      ids: normalizeWardIds(rows.map((row) => row.ward_id)),
      kothis: rows.map((row) => ({
        ward_id: row.ward_id,
        ward_name: row.ward_name,
        sector_id: row.sector_id,
        sector_name: row.sector_name,
        zone_id: row.zone_id,
        zone_name: row.zone_name,
        city_id: row.city_id,
        city_name: row.city_name,
      })),
    };
  }

  const payload = { ids: wardIds };
  kothiAccessCache.set(cacheKey, payload);
  return payload;
};

const syncUserKothiAccess = async (
  userId,
  wardIds = [],
  actorId = null,
  client = pool
) => {
  const ids = normalizeWardIds(wardIds);

  await client.query("DELETE FROM user_kothi_access WHERE user_id = $1", [
    userId,
  ]);

  if (ids.length === 0) {
    invalidateKothiAccessCache();
    return;
  }

  await client.query(
    `
      INSERT INTO user_kothi_access (user_id, ward_id, granted_at, granted_by)
      SELECT $1, UNNEST($2::int[]), NOW(), $3
      ON CONFLICT DO NOTHING
    `,
    [userId, ids, actorId ?? null]
  );

  invalidateKothiAccessCache();
};

module.exports = {
  fetchUserKothiAccess,
  normalizeWardIds, // Exported for use in routes
  syncUserKothiAccess,
  invalidateKothiAccessCache,
};
