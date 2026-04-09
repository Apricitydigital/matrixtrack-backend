const pool = require("../config/db");

/**
 * Calculates the distance between two points using the Haversine formula
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in meters
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Validates if a punch location is within the allowed geofencing boundaries for an employee
 * @param {number} empId Employee ID
 * @param {number} latitude Punch latitude
 * @param {number} longitude Punch longitude
 * @returns {Promise<{allowed: boolean, message?: string}>}
 */
async function validateGeofencing(empId, latitude, longitude) {
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const locationMissing = !latitude || !longitude || isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0);

    try {
        // 1. Get employee's ward and zone (JOIN with wards to get zone_id)
        const empResult = await pool.query(
            `SELECT e.ward_id, w.zone_id 
             FROM employee e
             LEFT JOIN wards w ON e.ward_id = w.ward_id
             WHERE e.emp_id = $1`,
            [empId]
        );

        if (empResult.rows.length === 0) return { allowed: true };


        const { ward_id, zone_id } = empResult.rows[0];

        // 2. Fetch geofencing rules for this ward (specific) or zone (fallback)
        // We prioritize ward-level geofencing
        let rulesResult = await pool.query(
            "SELECT latitude, longitude, radius, unit FROM geofencing WHERE ward_id = $1",
            [ward_id]
        );

        // If no ward rules, check zone rules
        if (rulesResult.rows.length === 0 && zone_id) {
            rulesResult = await pool.query(
                "SELECT latitude, longitude, radius, unit FROM geofencing WHERE zone_id = $1 AND ward_id IS NULL",
                [zone_id]
            );
        }

        // 3. If no rules are defined → ALLOW (Geofencing is optional/not yet mandatory for this ward)
        if (rulesResult.rows.length === 0) {
            return {
                allowed: true,
                notConfigured: true,
                message: "Geofencing not configured for this ward (Auto-allowed)"
            };
        }

        // 4. If location is missing/zero, we can't validate — block with message
        if (locationMissing) {
            return {
                allowed: false,
                notConfigured: false,
                message: "Location data is missing. Please enable GPS and try again."
            };
        }

        // 4. Check if punch is within ANY of the defined fences
        const punchLat = parseFloat(latitude);
        const punchLon = parseFloat(longitude);

        let isInside = false;
        let minDistanceFound = Infinity;

        for (const rule of rulesResult.rows) {
            const fenceLat = parseFloat(rule.latitude);
            const fenceLon = parseFloat(rule.longitude);
            let radius = parseFloat(rule.radius);

            if (rule.unit === 'kilometers' || rule.unit === 'KM') {
                radius *= 1000;
            }

            const distance = getDistance(fenceLat, fenceLon, punchLat, punchLon);
            minDistanceFound = Math.min(minDistanceFound, distance);

            if (distance <= radius) {
                isInside = true;
                break;
            }
        }

        if (isInside) {
            return { allowed: true };
        } else {
            return {
                allowed: false,
                message: `You are out of your assigned zone. (Distance: ${Math.round(minDistanceFound)}m)`
            };
        }
    } catch (error) {
        console.error("Geofencing validation error:", error);
        // On error, we default to allowed to prevent blocking users due to system failure
        return { allowed: true };
    }
}

module.exports = {
    validateGeofencing,
    getDistance
};
