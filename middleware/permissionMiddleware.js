const pool = require("../config/db");
const {
  fetchUserCityAccess,
  invalidateCityAccessCache,
} = require("../utils/userCityAccess");

const permissionCache = new Map();
let cacheVersion = 0;

const buildCacheKey = (userId) => `${userId}:${cacheVersion}`;

const invalidatePermissionCache = () => {
  cacheVersion += 1;
  permissionCache.clear();
  invalidateCityAccessCache();
};

const normalizeScope = (scope) => {
  if (!scope) {
    return { all: false, ids: new Set() };
  }

  if (scope.all) {
    return { all: true, ids: new Set() };
  }

  const rawIds = Array.isArray(scope.ids)
    ? scope.ids
    : Array.from(scope.ids || []);
  const ids = rawIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  return { all: false, ids: new Set(ids) };
};

const combineCityScopes = (baseScope, permissionScope) => {
  const base = normalizeScope(baseScope);
  const permission = normalizeScope(permissionScope);

  if (base.all) {
    return { all: true, ids: new Set() };
  }

  if (permission.all) {
    return { all: base.all, ids: new Set(base.ids) };
  }

  if (base.ids.size === 0 && permission.ids.size === 0) {
    return { all: false, ids: new Set() };
  }

  if (permission.ids.size === 0) {
    return { all: false, ids: new Set(base.ids) };
  }

  if (base.ids.size === 0) {
    return { all: false, ids: new Set() };
  }

  const intersection = new Set();
  base.ids.forEach((id) => {
    if (permission.ids.has(id)) {
      intersection.add(id);
    }
  });

  return { all: false, ids: intersection };
};

const fetchUserPermissions = async (userId) => {
  if (!userId) {
    return { set: new Set(), cityMap: new Map() };
  }

  const cacheKey = buildCacheKey(userId);
  if (permissionCache.has(cacheKey)) {
    return permissionCache.get(cacheKey);
  }

  const query = `
    SELECT p.module, p.action, NULL::int AS city_id
    FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    JOIN user_roles ur ON ur.role_id = rp.role_id
    WHERE ur.user_id = $1
    UNION ALL
    SELECT p.module, p.action, up.city_id
    FROM permissions p
    JOIN user_permissions up ON up.permission_id = p.id
    WHERE up.user_id = $1
  `;

  const { rows } = await pool.query(query, [userId]);

  const permissionSet = new Set();
  const cityMap = new Map();

  rows.forEach((row) => {
    const key = `${row.module}:${row.action}`.toLowerCase();
    permissionSet.add(key);

    if (!cityMap.has(key)) {
      cityMap.set(key, { all: false, ids: new Set() });
    }

    const scope = cityMap.get(key);
    if (row.city_id === null || row.city_id === undefined) {
      scope.all = true;
      scope.ids.clear();
    } else if (!scope.all) {
      scope.ids.add(row.city_id);
    }
  });

  const payload = { set: permissionSet, cityMap };
  permissionCache.set(cacheKey, payload);
  return payload;
};

const authorize = (requiredModule, requiredAction) => {
  return async (req, res, next) => {
    try {
      const userId =
        req.user?.user_id ??
        req.user?.id ??
        req.user?.userId ??
        null;

      if (!userId) {
        return res
          .status(401)
          .json({ error: "Unauthorized: user context missing" });
      }

      // Fetch the user's role and permissions from DB
      const userRes = await pool.query(
        "SELECT role, permissions FROM users WHERE user_id = $1",
        [userId]
      );
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: "Unauthorized: user not found" });
      }
      const dbUser = userRes.rows[0];

      if (dbUser.role === "admin") {
        if (!dbUser.permissions || dbUser.permissions.role_type === "super_admin") {
          return next();
        }

        if (dbUser.permissions.is_active === false) {
          return res.status(403).json({ error: "Forbidden: account is inactive" });
        }

        const modules = dbUser.permissions.modules || {};
        const normModule = requiredModule.toLowerCase().replace(/-/g, "_");
        const access = modules[normModule];

        if (access === "write") {
          return next();
        }
        if ((access === "view" || access === true) && requiredAction === "view") {
          return next();
        }

        return res.status(403).json({
          error: "Forbidden: missing permission",
          permission: `${requiredModule}:${requiredAction}`,
        });
      }

      // Supervisors inherently have dashboard view access for the mobile app
      if (dbUser.role === "supervisor" && requiredModule.toLowerCase() === "dashboard" && requiredAction === "view") {
         return next();
      }

      const permissionPayload = await fetchUserPermissions(userId);
      const requiredKey = `${requiredModule}:${requiredAction}`.toLowerCase();
      const candidateKeys =
        requiredAction === "view"
          ? [requiredKey, `${requiredModule}:write`.toLowerCase()]
          : [requiredKey];

      const matchedKey = candidateKeys.find((candidate) =>
        permissionPayload.set.has(candidate)
      );

      if (!matchedKey) {
        return res
          .status(403)
          .json({
            error: "Forbidden: missing permission",
            permission: requiredKey,
          });
      }

      const baseCityScope = await fetchUserCityAccess(req.user);
      const permissionScope = permissionPayload.cityMap.get(matchedKey);

      if (!req.permissionScopes) {
        req.permissionScopes = {};
      }

      const combinedScope = combineCityScopes(baseCityScope, permissionScope);
      req.permissionScopes[matchedKey] = {
        all: combinedScope.all,
        ids: combinedScope.ids,
      };

      return next();
    } catch (error) {
      console.error("Permission check failed:", error);
      return res.status(500).json({ error: "Permission check failed" });
    }
  };
};

const getPermissionCityFilter = (req, module, action) => {
  const key = `${module}:${action}`.toLowerCase();
  const fallbackKey =
    action === "view" ? `${module}:write`.toLowerCase() : null;
  const permissionScope =
    req.permissionScopes?.[key] ||
    (fallbackKey ? req.permissionScopes?.[fallbackKey] : null);
  const baseScope = req.cityScope || null;

  const combinedScope = combineCityScopes(baseScope, permissionScope);
  if (combinedScope.all) {
    return null;
  }
  if (!combinedScope.ids || combinedScope.ids.size === 0) {
    return [];
  }
  return Array.from(combinedScope.ids);
};

module.exports = {
  authorize,
  fetchUserPermissions,
  invalidatePermissionCache,
  getPermissionCityFilter,
  combineCityScopes,
};
