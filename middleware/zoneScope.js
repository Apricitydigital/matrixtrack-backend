const { fetchUserZoneAccess } = require("../utils/userZoneAccess");

const buildZoneScopeForUser = async (user) => {
  if (!user || !user.user_id) {
    return { all: false, ids: [] };
  }

  if (user.role && String(user.role).toLowerCase() === "admin") {
    return { all: true, ids: [] };
  }

  const scope = await fetchUserZoneAccess(user, { allowCityFallback: false });
  const ids = Array.isArray(scope.ids)
    ? scope.ids
        .map((zoneId) => Number(zoneId))
        .filter((zoneId) => Number.isFinite(zoneId))
    : [];

  return {
    all: false,
    ids,
  };
};

const attachZoneScope = async (req, res, next) => {
  try {
    req.zoneScope = await buildZoneScopeForUser(req.user);
    next();
  } catch (error) {
    console.error("Failed to resolve zone scope:", error);
    res.status(500).json({ error: "Unable to resolve zone access scope." });
  }
};

const assertZoneAccess = (scope, zoneId) => {
  if (!scope || scope.all) {
    return true;
  }
  const numeric = Number(zoneId);
  if (!Number.isFinite(numeric)) {
    return false;
  }
  return scope.ids.includes(numeric);
};

const buildZoneFilterClause = (scope, alias, params) => {
  if (!scope || scope.all) {
    return { clause: "", params };
  }
  if (!Array.isArray(scope.ids) || scope.ids.length === 0) {
    return { clause: "WHERE 1=0", params };
  }
  const nextParams = [...params, scope.ids];
  const placeholder = `$${nextParams.length}`;
  const clausePrefix = params.length > 0 ? "AND" : "WHERE";
  return {
    clause: `${clausePrefix} ${alias}.zone_id = ANY(${placeholder})`,
    params: nextParams,
  };
};

module.exports = {
  attachZoneScope,
  buildZoneScopeForUser,
  assertZoneAccess,
  buildZoneFilterClause,
};
