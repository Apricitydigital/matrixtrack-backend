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

/**
 * Validates if a supervisor is allowed to punch group attendance based on their assigned ward/zone geofence rules.
 * @param {number} supervisorUserId Supervisor User ID or Employee ID
 * @param {number} latitude Current latitude
 * @param {number} longitude Current longitude
 * @returns {Promise<{allowed: boolean, message?: string, notConfigured?: boolean}>}
 */
async function validateSupervisorGeofenceAccess(supervisorUserId, latitude, longitude) {
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const locationMissing = !latitude || !longitude || isNaN(lat) || isNaN(lon) || (lat === 0 && lon === 0);

    if (locationMissing) {
        return {
            allowed: false,
            message: "Location data is missing. Please enable GPS and try again."
        };
    }

    try {
        // 1. Resolve supervisor's assigned ward_ids and zone_ids
        const wardIds = new Set();
        const zoneIds = new Set();

        // Check supervisor_ward mapping
        try {
            const swRes = await pool.query(
                `SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1`,
                [supervisorUserId]
            );
            swRes.rows.forEach(r => r.ward_id && wardIds.add(r.ward_id));
        } catch (_) { }

        // Check user_kothi_access
        try {
            const ukRes = await pool.query(
                `SELECT ward_id FROM user_kothi_access WHERE user_id = $1`,
                [supervisorUserId]
            );
            ukRes.rows.forEach(r => r.ward_id && wardIds.add(r.ward_id));
        } catch (_) { }

        // Check supervisor_kothi
        try {
            const skRes = await pool.query(
                `SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1`,
                [supervisorUserId]
            );
            skRes.rows.forEach(r => r.ward_id && wardIds.add(r.ward_id));
        } catch (_) { }

        // Check user_zone_access
        try {
            const uzRes = await pool.query(
                `SELECT zone_id FROM user_zone_access WHERE user_id = $1`,
                [supervisorUserId]
            );
            uzRes.rows.forEach(r => r.zone_id && zoneIds.add(r.zone_id));
        } catch (_) { }

        // Check employee table for supervisor's own ward
        try {
            const empRes = await pool.query(
                `SELECT e.ward_id, w.zone_id FROM employee e LEFT JOIN wards w ON e.ward_id = w.ward_id WHERE e.emp_id = $1 OR e.emp_code = (SELECT emp_code FROM users WHERE user_id = $1 LIMIT 1)`,
                [supervisorUserId]
            );
            empRes.rows.forEach(r => {
                if (r.ward_id) wardIds.add(r.ward_id);
                if (r.zone_id) zoneIds.add(r.zone_id);
            });
        } catch (_) { }

        const wardArray = Array.from(wardIds);
        const zoneArray = Array.from(zoneIds);

        if (wardArray.length === 0 && zoneArray.length === 0) {
            return {
                allowed: false,
                notConfigured: true,
                message: "Supervisor is not assigned to any ward or zone boundaries."
            };
        }

        // 2. Fetch approved geofence rules from geofencing table AND approved geofencing_requests
        const rules = [];

        if (wardArray.length > 0) {
            const gRes = await pool.query(
                `SELECT latitude, longitude, radius, unit FROM geofencing WHERE ward_id = ANY($1::int[])`,
                [wardArray]
            );
            rules.push(...gRes.rows);

            const grRes = await pool.query(
                `SELECT latitude, longitude, 500 as radius, 'meters' as unit 
                 FROM geofencing_requests 
                 WHERE status = 'approved' AND (ward_id = ANY($1::int[]) OR supervisor_user_id = $2)`,
                [wardArray, supervisorUserId]
            );
            rules.push(...grRes.rows);
        }

        if (rules.length === 0 && zoneArray.length > 0) {
            const zRes = await pool.query(
                `SELECT latitude, longitude, radius, unit FROM geofencing WHERE zone_id = ANY($1::int[]) AND ward_id IS NULL`,
                [zoneArray]
            );
            rules.push(...zRes.rows);

            const zgrRes = await pool.query(
                `SELECT latitude, longitude, 500 as radius, 'meters' as unit 
                 FROM geofencing_requests 
                 WHERE status = 'approved' AND zone_id = ANY($1::int[])`,
                [zoneArray]
            );
            rules.push(...zgrRes.rows);
        }

        // Also check directly for supervisor_user_id approved requests
        if (rules.length === 0) {
            const userGrRes = await pool.query(
                `SELECT latitude, longitude, 500 as radius, 'meters' as unit 
                 FROM geofencing_requests 
                 WHERE status = 'approved' AND supervisor_user_id = $1`,
                [supervisorUserId]
            );
            rules.push(...userGrRes.rows);
        }

        // 3. If no approved rules exist in geofencing or geofencing_requests -> AUTO-ALLOW (prevents blocking unmapped wards in production)
        if (rules.length === 0) {
            return {
                allowed: true,
                notConfigured: true,
                message: "Supervisor geofence not configured yet (Auto-allowed)"
            };
        }

        // 4. Validate current distance against approved geofence rules
        let isInside = false;
        let minDistanceFound = Infinity;

        for (const rule of rules) {
            const fenceLat = parseFloat(rule.latitude);
            const fenceLon = parseFloat(rule.longitude);
            let radius = parseFloat(rule.radius);

            if (rule.unit === 'kilometers' || rule.unit === 'KM') {
                radius *= 1000;
            }

            const distance = getDistance(fenceLat, fenceLon, lat, lon);
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
                message: `Supervisor is out of assigned geo-fence zone. (Distance: ${Math.round(minDistanceFound)}m)`
            };
        }

    } catch (error) {
        console.error("validateSupervisorGeofenceAccess error:", error);
        return { allowed: false, message: "Geofence validation failed. Please try again." };
    }
}

module.exports = {
    validateGeofencing,
    validateSupervisorGeofenceAccess,
    getDistance
};

