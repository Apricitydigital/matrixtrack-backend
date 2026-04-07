const { fetchUserKothiAccess } = require("../utils/userKothiAccess");

/**
 * Middleware to attach Kothi (Ward) access scope to the request.
 * req.kothiScope = { all: boolean, ids: number[] }
 */
const attachKothiScope = async (req, res, next) => {
  try {
    if (!req.user || !req.user.user_id) {
      req.kothiScope = { all: false, ids: [] };
      return next();
    }

    // Admin has access to all Kothis
    if (req.user.role && req.user.role.toLowerCase() === "admin") {
      req.kothiScope = { all: true, ids: [] };
      return next();
    }

    // Supervisors/Users get filtered by their assignments
    const scope = await fetchUserKothiAccess(req.user.user_id, {
      allowZoneFallback: true,
      allowCityFallback: false,
    });
    req.kothiScope = {
      all: Array.isArray(scope.ids) ? false : Boolean(scope.all),
      ids: Array.isArray(scope.ids) ? scope.ids : [],
    };
    next();
  } catch (error) {
    console.error("Failed to resolve Kothi scope:", error);
    res.status(500).json({ error: "Unable to resolve Kothi access scope." });
  }
};

/**
 * Builds a WHERE clause segment for filtering by ward_id (Kothi).
 * @param {object} scope - req.kothiScope
 * @param {string} alias - table alias for wards (e.g., 'w')
 * @param {array} params - query parameters array
 */
const buildKothiFilterClause = (scope, alias, params) => {
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
    clause: `${clausePrefix} ${alias}.ward_id = ANY(${placeholder})`,
    params: nextParams,
  };
};

module.exports = {
  attachKothiScope,
  buildKothiFilterClause,
};
