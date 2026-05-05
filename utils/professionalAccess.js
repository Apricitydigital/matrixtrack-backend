/**
 * Generates the visibility CTE and WHERE clause components based on user role.
 * 
 * @param {Object} user - req.user
 * @param {Object} cityScope - req.cityScope
 * @param {string} tableAlias - alias for the table to filter (e.g. 'pa', 'pe')
 * @returns {Object} { cte: string, whereClause: string, params: Array }
 */
const buildVisibilityScope = (user, cityScope, tableAlias = 'pa') => {
  const role = user?.role?.toLowerCase();
  let cte = '';
  let whereClause = '1=1';
  let params = [];

  if (role === 'admin') {
    if (!cityScope || cityScope.all) {
      whereClause = '1=1'; // Access to all
    } else if (cityScope.ids && cityScope.ids.length > 0) {
      // Append city IDs array as the first parameter
      params.push(cityScope.ids);
      whereClause = `${tableAlias}.city_id = ANY($1::int[])`;
    } else {
      whereClause = '1=0'; // Scope explicitly empty
    }
  } else if (role === 'supervisor') {
    const supervisorId = user.user_id || user.id || user.userId;
    params.push(supervisorId);

    cte = `
      WITH assigned_wards AS (
        SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1
        UNION
        SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
        UNION
        SELECT ward_id FROM user_kothi_access WHERE user_id = $1
      ),
      assigned_sectors AS (
        SELECT DISTINCT w.sector_id
        FROM wards w
        JOIN assigned_wards a ON a.ward_id = w.ward_id
        WHERE w.sector_id IS NOT NULL
        UNION
        SELECT DISTINCT a.ward_id AS sector_id
        FROM assigned_wards a
        JOIN sectors s ON s.sector_id = a.ward_id
        UNION
        SELECT DISTINCT s.sector_id
        FROM sectors s
        JOIN user_zone_access uza ON uza.zone_id = s.zone_id
        WHERE uza.user_id = $1
      ),
      assigned_zones AS (
        SELECT zone_id FROM user_zone_access WHERE user_id = $1
        UNION
        SELECT DISTINCT COALESCE(w.zone_id, s.zone_id) AS zone_id
        FROM wards w
        LEFT JOIN sectors s ON s.sector_id = w.sector_id
        JOIN assigned_wards a ON a.ward_id = w.ward_id
        WHERE COALESCE(w.zone_id, s.zone_id) IS NOT NULL
        UNION
        SELECT DISTINCT s.zone_id
        FROM sectors s
        JOIN assigned_sectors sec ON sec.sector_id = s.sector_id
        WHERE s.zone_id IS NOT NULL
        UNION
        SELECT DISTINCT z.zone_id
        FROM zones z
        JOIN user_city_access uca ON uca.city_id = z.city_id
        WHERE uca.user_id = $1
      ),
      assigned_cities AS (
        SELECT city_id FROM user_city_access WHERE user_id = $1
        UNION
        SELECT DISTINCT z.city_id
        FROM zones z
        JOIN assigned_zones az ON az.zone_id = z.zone_id
        WHERE z.city_id IS NOT NULL
      )
    `;
    whereClause = `
      (
        ${tableAlias}.city_id IN (SELECT city_id FROM assigned_cities)
        OR ${tableAlias}.zone_id IN (SELECT zone_id FROM assigned_zones)
        OR ${tableAlias}.ward_id IN (SELECT ward_id FROM assigned_wards)
        OR ${tableAlias}.ward_id IN (SELECT sector_id FROM assigned_sectors)
        OR EXISTS (
          SELECT 1
          FROM wards w_scope
          WHERE w_scope.ward_id = ${tableAlias}.ward_id
            AND w_scope.sector_id IN (SELECT sector_id FROM assigned_sectors)
        )
      )
    `;
  } else {
    // Unknown role -> deny access
    whereClause = '1=0';
  }

  return { cte, whereClause, params };
};

module.exports = {
  buildVisibilityScope
};
