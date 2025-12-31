const pool = require("../config/db");

const cityAccessCache = new Map();
let cityAccessVersion = 0;

const buildCacheKey = (userId) => `${userId || "unknown"}:${cityAccessVersion}`;

const invalidateCityAccessCache = () => {
  cityAccessVersion += 1;
  cityAccessCache.clear();
};

const normalizeCityIds = (cityIds = []) => {
  const seen = new Set();
  const normalized = [];

  (cityIds || []).forEach((raw) => {
    const value = Number(raw);
    if (Number.isFinite(value) && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  });

  return normalized;
};

const fetchCitiesFromAssignments = async (userId, includeCityMetadata = false) => {
  if (!userId) {
    return { ids: [], cities: [] };
  }

  const query = includeCityMetadata
    ? `
        SELECT DISTINCT c.city_id, c.city_name
        FROM supervisor_ward sw
        JOIN wards w ON w.ward_id = sw.ward_id
        JOIN zones z ON z.zone_id = w.zone_id
        JOIN cities c ON c.city_id = z.city_id
        WHERE sw.supervisor_id = $1
        ORDER BY c.city_name ASC
      `
    : `
        SELECT DISTINCT c.city_id
        FROM supervisor_ward sw
        JOIN wards w ON w.ward_id = sw.ward_id
        JOIN zones z ON z.zone_id = w.zone_id
        JOIN cities c ON c.city_id = z.city_id
        WHERE sw.supervisor_id = $1
      `;

  const { rows } = await pool.query(query, [userId]);
  const ids = normalizeCityIds(rows.map((row) => row.city_id));

  return {
    ids,
    cities: includeCityMetadata ? rows.map((row) => ({
      city_id: row.city_id,
      city_name: row.city_name,
    })) : [],
  };
};

const fetchUserCityAccess = async (user, options = {}) => {
  const userId =
    (typeof user === "object" && user !== null ? user.user_id : null) ||
    Number(user) ||
    null;
  const role =
    (typeof user === "object" && user !== null ? user.role : null) || null;
  const includeCityMetadata = options.includeCities || options.withNames;
  const allowAssignmentsFallback =
    options.allowAssignmentsFallback === undefined
      ? true
      : Boolean(options.allowAssignmentsFallback);

  if (!userId) {
    return { all: false, ids: [], cities: [] };
  }

  if (role && typeof role === "string" && role.toLowerCase() === "admin") {
    if (includeCityMetadata) {
      const { rows } = await pool.query(
        "SELECT city_id, city_name FROM cities ORDER BY city_name ASC"
      );
      const ids = normalizeCityIds(rows.map((row) => row.city_id));
      return { all: true, ids, cities: rows };
    }
    return { all: true, ids: [] };
  }

  const cacheKey = buildCacheKey(userId);
  if (!includeCityMetadata && allowAssignmentsFallback && cityAccessCache.has(cacheKey)) {
    const cached = cityAccessCache.get(cacheKey);
    if (cached?.all || (Array.isArray(cached?.ids) && cached.ids.length > 0)) {
      return cached;
    }
    // fall through to recompute so we can derive from assignments
  }

  const queryText = includeCityMetadata
    ? `
        SELECT c.city_id, c.city_name
        FROM user_city_access uca
        JOIN cities c ON c.city_id = uca.city_id
        WHERE uca.user_id = $1
        ORDER BY c.city_name ASC
      `
    : `
        SELECT city_id
        FROM user_city_access
        WHERE user_id = $1
      `;

  const { rows } = await pool.query(queryText, [userId]);
  const ids = normalizeCityIds(
    includeCityMetadata ? rows.map((row) => row.city_id) : rows.map((row) => row.city_id)
  );

  let payload = includeCityMetadata
    ? { all: false, ids, cities: rows }
    : { all: false, ids };

  if (
    allowAssignmentsFallback &&
    !payload.all &&
    (!Array.isArray(payload.ids) || payload.ids.length === 0)
  ) {
    const assignmentScope = await fetchCitiesFromAssignments(
      userId,
      includeCityMetadata
    );
    if (assignmentScope.ids.length > 0) {
      payload = includeCityMetadata
        ? { all: false, ids: assignmentScope.ids, cities: assignmentScope.cities }
        : { all: false, ids: assignmentScope.ids };
    }
  }

  if (!includeCityMetadata && allowAssignmentsFallback) {
    cityAccessCache.set(cacheKey, payload);
  }

  return payload;
};

const syncUserCityAccess = async (
  userId,
  cityIds = [],
  actorId = null,
  client = pool
) => {
  const ids = normalizeCityIds(cityIds);

  await client.query("DELETE FROM user_city_access WHERE user_id = $1", [
    userId,
  ]);

  if (ids.length === 0) {
    invalidateCityAccessCache();
    return;
  }

  await client.query(
    `
      INSERT INTO user_city_access (user_id, city_id, granted_at, granted_by)
      SELECT $1, UNNEST($2::int[]), NOW(), $3
      ON CONFLICT DO NOTHING
    `,
    [userId, ids, actorId ?? null]
  );

  invalidateCityAccessCache();
};

module.exports = {
  fetchUserCityAccess,
  normalizeCityIds,
  syncUserCityAccess,
  invalidateCityAccessCache,
  fetchCitiesFromAssignments,
};
