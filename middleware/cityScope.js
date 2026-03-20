const { fetchUserCityAccess } = require("../utils/userCityAccess");

const buildCityScopeForUser = async (user) => {
  if (!user || !user.user_id) {
    return { all: false, ids: [] };
  }

  if (user.role && user.role.toLowerCase() === "admin") {
    return { all: true, ids: [] };
  }

  const scope = await fetchUserCityAccess(user);
  return {
    all: Boolean(scope.all),
    ids: Array.isArray(scope.ids) ? scope.ids : [],
  };
};

const attachCityScope = async (req, res, next) => {
  try {
    const scope = await buildCityScopeForUser(req.user);
    req.cityScope = scope;
    next();
  } catch (error) {
    console.error("Failed to resolve city scope:", error);
    res.status(500).json({ error: "Unable to resolve city access scope." });
  }
};

const requireCityScope = (allowEmptyForAdmin = false) => (req, res, next) => {
  const scope = req.cityScope || { all: false, ids: [] };
  if (scope.all) {
    return next();
  }
  if (Array.isArray(scope.ids) && scope.ids.length > 0) {
    return next();
  }
  if (allowEmptyForAdmin && req.user?.role?.toLowerCase() === "admin") {
    return next();
  }
  return res
    .status(403)
    .json({ error: "No city access assigned. Please contact admin." });
};

const assertCityAccess = (scope, cityId) => {
  if (!scope || scope.all) {
    return true;
  }
  const numeric = Number(cityId);
  if (!Number.isFinite(numeric)) {
    return false;
  }
  return scope.ids.includes(numeric);
};

const buildCityFilterClause = (scope, alias, params) => {
  if (!scope || scope.all) {
    return { clause: "", params };
  }
  if (!scope.ids || scope.ids.length === 0) {
    const clausePrefix = params.length > 0 ? "AND" : "WHERE";
    return { clause: `${clausePrefix} 1=0`, params };
  }
  const nextParams = [...params, scope.ids];
  const placeholder = `$${nextParams.length}`;
  const clausePrefix = params.length > 0 ? "AND" : "WHERE";
  return {
    clause: `${clausePrefix} ${alias}.city_id = ANY(${placeholder})`,
    params: nextParams,
  };
};

module.exports = {
  attachCityScope,
  requireCityScope,
  assertCityAccess,
  buildCityScopeForUser,
  buildCityFilterClause,
};
