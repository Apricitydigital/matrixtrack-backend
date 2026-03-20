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

  if (!userId) {
    return { ids: [], kothis: [] };
  }

  const cacheKey = buildCacheKey(userId);
  if (!includeMetadata && kothiAccessCache.has(cacheKey)) {
    return kothiAccessCache.get(cacheKey);
  }

  const queryText = includeMetadata
    ? `
        WITH all_ward_ids AS (
          SELECT ward_id FROM user_kothi_access WHERE user_id = $1
          UNION
          SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
          UNION
          SELECT ward_id FROM wards WHERE sector_id IN (SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1)
        )
        SELECT DISTINCT w.ward_id, w.ward_name, s.sector_id, s.sector_name, z.zone_id, z.zone_name, c.city_id, c.city_name
        FROM all_ward_ids awi
        JOIN wards w ON w.ward_id = awi.ward_id
        LEFT JOIN sectors s ON s.sector_id = w.sector_id
        LEFT JOIN zones z ON z.zone_id = COALESCE(s.zone_id, w.zone_id)
        LEFT JOIN cities c ON c.city_id = z.city_id
        ORDER BY w.ward_name ASC
      `
    : `
        SELECT ward_id FROM user_kothi_access WHERE user_id = $1
        UNION
        SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
        UNION
        SELECT ward_id FROM wards WHERE sector_id IN (SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1)
      `;

  const { rows } = await pool.query(queryText, [userId]);
  const ids = normalizeWardIds(rows.map((row) => row.ward_id));

  const payload = includeMetadata
    ? {
        ids,
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
      }
    : { ids };

  if (!includeMetadata) {
    kothiAccessCache.set(cacheKey, payload);
  }

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
