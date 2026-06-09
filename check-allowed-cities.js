const pool = require('./config/db');
const { fetchUserCityAccess } = require('./utils/userCityAccess');

const getUserAccessProfile = async (userId, userRole = "") => {
  const rolesQuery = `
    SELECT r.id, r.name
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = $1
  `;
  const permissionsQuery = `
    SELECT DISTINCT p.id, p.module, p.action, p.label, up.city_id
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = $1
    UNION
    SELECT DISTINCT p.id, p.module, p.action, p.label, NULL::int AS city_id
    FROM role_permissions rp
    JOIN user_roles ur ON ur.role_id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = $1
    ORDER BY module, action
  `;
  const [rolesResult, permissionsResult] = await Promise.all([
    pool.query(rolesQuery, [userId]),
    pool.query(permissionsQuery, [userId]),
  ]);
  return {
    roles: rolesResult.rows,
    permissions: permissionsResult.rows,
  };
};

const computeAllowedCities = async (userRow, access) => {
  const isAdminRole =
    (userRow?.role || "").toLowerCase() === "admin" ||
    access?.roles?.some(
      (role) => (role.name || "").toLowerCase() === "admin"
    );
  if (isAdminRole) {
    return null; // all cities
  }

  const scope = await fetchUserCityAccess(userRow);
  if (scope.all) {
    return null;
  }

  const ids = Array.isArray(scope.ids) ? scope.ids : [];
  const list = ids
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
  return list.length ? list : [];
};

async function test() {
  try {
    const userRow = (await pool.query("SELECT * FROM users WHERE user_id = 833")).rows[0];
    console.log('User row:', userRow);
    const access = await getUserAccessProfile(833, userRow.role);
    console.log('Access Profile:', access);
    const allowedCities = await computeAllowedCities(userRow, access);
    console.log('Allowed Cities:', allowedCities);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

test();
