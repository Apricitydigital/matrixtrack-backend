// Resolve one sector per request. Sector IDs and legacy ward IDs can overlap;
// joining all possible matches with OR multiplies requests before pagination.
const requestSectorId = `COALESCE(
  (SELECT k.sector_id FROM wards k WHERE k.ward_id = spr.kothi_id),
  (SELECT direct.sector_id FROM sectors direct WHERE direct.sector_id = spr.ward_id
    AND (spr.zone_id IS NULL OR direct.zone_id = spr.zone_id)),
  (SELECT legacy.sector_id FROM wards legacy WHERE legacy.ward_id = spr.ward_id)
)`;

const requestLocationJoins = `
  LEFT JOIN wards w ON spr.kothi_id = w.ward_id
  LEFT JOIN wards w_from_ward ON spr.ward_id = w_from_ward.ward_id
  LEFT JOIN sectors s ON s.sector_id = ${requestSectorId}`;

module.exports = { requestSectorId, requestLocationJoins };
