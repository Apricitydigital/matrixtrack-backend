const pool = require("../config/db");

// Mocking the behavior of fetchSupervisorEmployees
const fetchSupervisorEmployees = async (
  userId,
  cityId,
  startDate,
  endDate,
  options = {}
) => {
  const { zoneIds = [], kothiIds = [], allowCityFallback = false } = options;
  const hasZoneFilter = Array.isArray(zoneIds) && zoneIds.length > 0;
  const hasKothiFilter = Array.isArray(kothiIds) && kothiIds.length > 0;
  
  const params = [userId ?? null, startDate, endDate, cityId ?? null];
  
  let accessFilter = "TRUE";
  // The FIX applies here: remove !hasZoneFilter && !hasKothiFilter
  if (!allowCityFallback && userId) {
    accessFilter = `($1::int IS NULL OR sw_exists.is_assigned OR kothi_rbac.is_assigned OR sup_kothi_rbac.is_assigned OR zone_rbac.is_assigned)`;
  }
  
  let whereClauses = [`($4::int IS NULL OR c.city_id = $4::int)`];
  
  if (hasZoneFilter) {
    params.push(zoneIds);
    whereClauses.push(`z.zone_id = ANY($${params.length}::int[])`);
  }
  
  if (hasKothiFilter) {
    params.push(kothiIds);
    whereClauses.push(`w.ward_id = ANY($${params.length}::int[])`);
  }

  const query = `
    SELECT DISTINCT ON (e.emp_id)
      e.emp_id,
      e.name AS employee_name
    FROM employee e
    LEFT JOIN wards w ON e.ward_id = w.ward_id
    LEFT JOIN zones z ON w.zone_id = z.zone_id
    LEFT JOIN cities c ON z.city_id = c.city_id
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM supervisor_ward sw WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $1) AS is_assigned) sw_exists ON TRUE
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM user_kothi_access uk WHERE uk.ward_id = e.ward_id AND uk.user_id = $1) AS is_assigned) kothi_rbac ON TRUE
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM supervisor_kothi sk WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $1) AS is_assigned) sup_kothi_rbac ON TRUE
    LEFT JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM user_zone_access uz WHERE uz.zone_id = w.zone_id AND uz.user_id = $1) AS is_assigned) zone_rbac ON TRUE
    WHERE ${accessFilter}
      AND ${whereClauses.join(' AND ')}
  `;

  const result = await pool.query(query, params);
  return result.rows;
};

async function verify() {
  try {
    const userId = 991; // Vikrant
    const cityId = 1;
    const today = new Date().toISOString().split('T')[0];

    console.log("Testing with NO filters...");
    const base = await fetchSupervisorEmployees(userId, cityId, today, today);
    console.log(`Employees found: ${base.length}`);

    console.log("\nTesting with filter for Ward 66 (Not assigned to Vikrant)...");
    const restricted = await fetchSupervisorEmployees(userId, cityId, today, today, { kothiIds: [66] });
    console.log(`Employees found: ${restricted.length}`);

    if (restricted.length === 0) {
        console.log("\n✅ SUCCESS: RBAC is now correctly enforced with filters.");
    } else {
        console.log("\n❌ FAILURE: RBAC is still being bypassed with filters!");
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

verify();
