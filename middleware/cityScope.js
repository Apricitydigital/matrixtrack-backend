const { fetchUserCityAccess } = require("../utils/userCityAccess");

const buildCityScopeForUser = async (user) => {
  const userId =
    user?.user_id ??
    user?.id ??
    user?.userId ??
    (typeof user === "number" ? user : null);

  if (!user || !userId) {
    return { all: false, ids: [] };
  }

  if (user.role && user.role.toLowerCase() === "admin") {
    return { all: true, ids: [] };
  }

  const scope = await fetchUserCityAccess({ ...user, user_id: userId });
  const ids = Array.isArray(scope.ids) ? scope.ids : [];
  // If nothing is assigned, leave scope empty (handled downstream).
  return { all: Boolean(scope.all), ids };
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

const requireCityScope =
  (allowEmptyForAdmin = false, allowEmptyForAll = false) =>
  (req, res, next) => {
    const scope = req.cityScope || { all: false, ids: [] };

    // Admins always allowed
    if (req.user?.role?.toLowerCase() === "admin") {
      return next();
    }

    // Explicit access present
    if (scope.all || (Array.isArray(scope.ids) && scope.ids.length > 0)) {
      return next();
    }

    // Configured bypasses
    if (allowEmptyForAdmin || allowEmptyForAll) {
      console.warn(
        "City scope empty, bypassing check for user",
        req.user?.user_id || req.user?.id || "unknown"
      );
      return next();
    }

    // Soft-fail: allow request but annotate scope for downstream to return empty data
    console.warn(
      "City scope empty; continuing with no-access scope for user",
      req.user?.user_id || req.user?.id || "unknown"
    );
    return next();
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
