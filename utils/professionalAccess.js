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
      WITH has_explicit_scope AS (
        SELECT EXISTS (
          SELECT 1 FROM user_city_access WHERE user_id = $1
          UNION ALL
          SELECT 1 FROM user_zone_access WHERE user_id = $1
          UNION ALL
          SELECT 1 FROM user_kothi_access WHERE user_id = $1
        ) AS enabled
      ),
      assigned_kothis AS (
        SELECT ward_id FROM user_kothi_access WHERE user_id = $1
        UNION
        SELECT ward_id
        FROM supervisor_kothi
        WHERE supervisor_id = $1
          AND NOT (SELECT enabled FROM has_explicit_scope)
        UNION
        -- Legacy fallback: some old supervisor_ward rows stored sector_id instead of ward_id.
        -- Expand those legacy sector mappings into actual kothi ward_ids only when explicit RBAC scope is absent.
        SELECT w.ward_id
        FROM supervisor_ward sw_legacy
        LEFT JOIN wards w_direct ON w_direct.ward_id = sw_legacy.ward_id
        JOIN wards w ON w.sector_id = sw_legacy.ward_id
        WHERE sw_legacy.supervisor_id = $1
          AND w_direct.ward_id IS NULL
          AND NOT (SELECT enabled FROM has_explicit_scope)
      ),
      assigned_wards AS (
        SELECT ward_id
        FROM supervisor_ward
        WHERE supervisor_id = $1
          AND NOT (SELECT enabled FROM has_explicit_scope)
          AND EXISTS (
            SELECT 1
            FROM wards w_real
            WHERE w_real.ward_id = supervisor_ward.ward_id
          )
        UNION
        SELECT ward_id
        FROM assigned_kothis
        WHERE NOT EXISTS (
          SELECT 1
          FROM wards w_child
          WHERE w_child.ward_id = assigned_kothis.ward_id
            AND w_child.sector_id IS NOT NULL
        )
        UNION
        SELECT ward_id
        FROM assigned_kothis
        WHERE NOT (SELECT enabled FROM has_explicit_scope)
          AND EXISTS (
            SELECT 1
            FROM wards w_child
            WHERE w_child.ward_id = assigned_kothis.ward_id
          )
      ),
      assigned_sectors AS (
        -- Sectors derived from assigned kothis
        SELECT DISTINCT w.sector_id
        FROM wards w
        JOIN assigned_kothis a ON a.ward_id = w.ward_id
        WHERE w.sector_id IS NOT NULL
        UNION
        -- Direct ward/sector assignments from legacy tables
        SELECT DISTINCT a.ward_id AS sector_id
        FROM assigned_wards a
        JOIN sectors s ON s.sector_id = a.ward_id
        UNION
        -- Zone access grants every sector in that zone
        SELECT DISTINCT s.sector_id
        FROM sectors s
        JOIN user_zone_access uza ON uza.zone_id = s.zone_id
        WHERE uza.user_id = $1
      ),
      assigned_zones AS (
        -- Direct zone assignments
        SELECT zone_id FROM user_zone_access WHERE user_id = $1
        UNION
        -- Zones inferred from assigned kothis
        SELECT DISTINCT COALESCE(w.zone_id, s.zone_id) AS zone_id
        FROM wards w
        LEFT JOIN sectors s ON s.sector_id = w.sector_id
        JOIN assigned_kothis a ON a.ward_id = w.ward_id
        WHERE COALESCE(w.zone_id, s.zone_id) IS NOT NULL
        UNION
        -- Zones inferred from direct ward/sector assignments
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
        -- City-level access: expand to ALL zones ONLY when user has no zone restrictions for that city
        SELECT DISTINCT z.zone_id
        FROM zones z
        JOIN user_city_access uca ON uca.city_id = z.city_id
        WHERE uca.user_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM user_zone_access uza2
            JOIN zones z2 ON uza2.zone_id = z2.zone_id
            WHERE uza2.user_id = $1 AND z2.city_id = uca.city_id
          )
      ),
      -- Full-city access: user has city access AND no zone-level restrictions for that city.
      -- Only these cities appear in the WHERE city-level check to prevent leaking
      -- requests from unassigned zones that share the same city.
      full_city_access AS (
        SELECT uca.city_id
        FROM user_city_access uca
        WHERE uca.user_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM user_zone_access uza2
            JOIN zones z2 ON uza2.zone_id = z2.zone_id
            WHERE uza2.user_id = $1 AND z2.city_id = uca.city_id
          )
      )
    `;
    whereClause = `
      (
        ${tableAlias}.city_id IN (SELECT city_id FROM full_city_access)
        OR ${tableAlias}.zone_id IN (SELECT zone_id FROM assigned_zones)
        OR ${tableAlias}.kothi_id IN (SELECT ward_id FROM assigned_kothis)
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
