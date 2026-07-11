// middleware/auditLoggerMiddleware.js
const { getEnvironmentScope, uploadAuditLog } = require("../utils/s3Logger");
const pool = require("../config/db");
const AUDITABLE_PREFIXES = [
  "/api/admin-management",
  "/api/rbac",
  "/api/log-page-visit",
  "/api/log-action",
  "/api/employees",
  "/api/supervisor",
  "/api/assignedWardRoutes",
  "/api/assignedKothiRoutes",
  "/api/geofencing",
  "/api/cities",
  "/api/zones",
  "/api/wards",
  "/api/sectors",
  "/api/departments",
  "/api/designations",
  "/api/announcements",
  "/api/feedback",
  "/api/migration",
  "/api/employee-migration",
];
const AUDITABLE_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/auth/update",
]);

// Helper to extract identifier (numeric or UUID) from the end of the URL path
const extractIdFromUrl = (url) => {
  const parts = url.split("?")[0].split("/");
  const last = parts[parts.length - 1];
  if (
    last &&
    (last.match(/^[0-9a-fA-F-]+$/) || !isNaN(last)) &&
    last !== "log-page-visit" &&
    last !== "log-action" &&
    last !== "audit-logs" &&
    last !== "merge" &&
    last !== "approve" &&
    last !== "reject"
  ) {
    return last;
  }
  return null;
};

const fetchDeleteContext = async (req) => {
  const normalizedPath = (req.originalUrl || req.url || "").split("?")[0];
  let entityId = req.params?.id ? Number(req.params.id) : null;
  if (!entityId || isNaN(entityId)) {
    const extracted = extractIdFromUrl(normalizedPath);
    if (extracted && !isNaN(extracted)) {
      entityId = Number(extracted);
    }
  }

  if (req.method !== "DELETE" || !Number.isFinite(entityId)) {
    return null;
  }

  if (normalizedPath.startsWith("/api/employees/")) {
    const { rows } = await pool.query(
      `SELECT
         e.emp_id,
         e.name,
         e.emp_code,
         c.city_name,
         z.zone_name,
         s.sector_name,
         w.ward_name
       FROM employee e
       LEFT JOIN wards w ON e.ward_id = w.ward_id
       LEFT JOIN sectors s ON w.sector_id = s.sector_id
       LEFT JOIN zones z ON COALESCE(w.zone_id, s.zone_id) = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE e.emp_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "employee",
        employee: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/wards/")) {
    const { rows } = await pool.query(
      `SELECT
         w.ward_id,
         w.ward_name,
         s.sector_name,
         z.zone_name,
         c.city_name
       FROM wards w
       LEFT JOIN sectors s ON w.sector_id = s.sector_id
       LEFT JOIN zones z ON w.zone_id = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE w.ward_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "kothi",
        kothi: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/sectors/")) {
    const { rows } = await pool.query(
      `SELECT
         s.sector_id,
         s.sector_name,
         z.zone_name,
         c.city_name,
         COUNT(w.ward_id)::int AS kothi_count
       FROM sectors s
       LEFT JOIN zones z ON s.zone_id = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       LEFT JOIN wards w ON w.sector_id = s.sector_id
       WHERE s.sector_id = $1
       GROUP BY s.sector_id, s.sector_name, z.zone_name, c.city_name
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "ward",
        ward: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/zones/")) {
    const { rows } = await pool.query(
      `SELECT z.zone_id, z.zone_name, c.city_name
       FROM zones z
       LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE z.zone_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "zone",
        zone: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/cities/")) {
    const { rows } = await pool.query(
      `SELECT city_id, city_name, state
       FROM public.cities
       WHERE city_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "city",
        city: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/departments/")) {
    const { rows } = await pool.query(
      `SELECT department_id, department_name
       FROM department
       WHERE department_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "department",
        department: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/designations/")) {
    const { rows } = await pool.query(
      `SELECT d.designation_id, d.designation_name, dept.department_name
       FROM designation d
       LEFT JOIN department dept ON d.department_id = dept.department_id
       WHERE d.designation_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "designation",
        designation: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/supervisor/")) {
    const { rows } = await pool.query(
      `WITH all_assignments AS (
         SELECT user_id, ward_id FROM user_kothi_access
         UNION
         SELECT supervisor_id AS user_id, ward_id FROM supervisor_kothi
         UNION
         SELECT supervisor_id AS user_id, ward_id FROM supervisor_ward
       )
       SELECT
         u.user_id,
         u.name,
         u.emp_code,
         u.email,
         u.phone,
         STRING_AGG(DISTINCT c.city_name, ', ') AS city_name,
         STRING_AGG(DISTINCT z.zone_name, ', ') AS zone_name,
         STRING_AGG(DISTINCT s.sector_name, ', ') AS ward_name,
         STRING_AGG(DISTINCT w.ward_name, ', ') AS kothi_name
       FROM users u
       LEFT JOIN all_assignments aa ON u.user_id = aa.user_id
       LEFT JOIN wards w ON aa.ward_id = w.ward_id
       LEFT JOIN sectors s ON w.sector_id = s.sector_id
       LEFT JOIN zones z ON COALESCE(s.zone_id, w.zone_id) = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE u.user_id = $1
       GROUP BY u.user_id, u.name, u.emp_code, u.email, u.phone
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "supervisor",
        supervisor: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/assignedWardRoutes/")) {
    const { rows } = await pool.query(
      `SELECT
         sw.assigned_id,
         u.name,
         u.emp_code,
         w.ward_name,
         z.zone_name,
         c.city_name
       FROM supervisor_ward sw
       JOIN users u ON sw.supervisor_id = u.user_id
       JOIN wards w ON sw.ward_id = w.ward_id
       JOIN zones z ON w.zone_id = z.zone_id
       JOIN cities c ON z.city_id = c.city_id
       WHERE sw.assigned_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "supervisorWardAssignment",
        supervisorWardAssignment: rows[0],
      };
    }
  }

  if (normalizedPath.startsWith("/api/assignedKothiRoutes/")) {
    const { rows } = await pool.query(
      `SELECT
         sk.assigned_id,
         u.name,
         u.emp_code,
         w.ward_name AS kothi_name,
         s.sector_name AS ward_name,
         z.zone_name,
         c.city_name
       FROM supervisor_kothi sk
       JOIN users u ON sk.supervisor_id = u.user_id
       JOIN wards w ON sk.ward_id = w.ward_id
       LEFT JOIN sectors s ON w.sector_id = s.sector_id
       LEFT JOIN zones z ON COALESCE(s.zone_id, w.zone_id) = z.zone_id
       LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE sk.assigned_id = $1
       LIMIT 1`,
      [entityId]
    );

    if (rows.length > 0) {
      return {
        entityType: "supervisorKothiAssignment",
        supervisorKothiAssignment: rows[0],
      };
    }
  }

  return null;
};
// Simple user-agent parser for OS/Browser info
const parseUserAgent = (uaString) => {
  if (!uaString) return "Unknown Device";
  let browser = "Unknown Browser";
  let os = "Unknown OS";

  if (uaString.includes("Firefox/")) browser = "Firefox";
  else if (uaString.includes("Chrome/")) browser = "Chrome";
  else if (uaString.includes("Safari/")) browser = "Safari";
  else if (uaString.includes("Edge/") || uaString.includes("Edg/")) browser = "Edge";
  else if (uaString.includes("Postman")) browser = "Postman";

  if (uaString.includes("Windows")) os = "Windows";
  else if (uaString.includes("Macintosh") || uaString.includes("Mac OS")) os = "macOS";
  else if (uaString.includes("Linux")) os = "Linux";
  else if (uaString.includes("Android")) os = "Android";
  else if (uaString.includes("iPhone") || uaString.includes("iPad")) os = "iOS";

  return `${browser} on ${os}`;
};

// Helper to mask sensitive fields in JSON payload
const maskPayload = (data) => {
  if (!data || typeof data !== "object") return data;
  const masked = { ...data };
  const keysToMask = ["password", "confirmPassword", "token", "token_hash", "password_hash", "secret"];
  for (let key of keysToMask) {
    if (key in masked) {
      masked[key] = "[MASKED]";
    }
  }
  return masked;
};

// Enrich payload: replace raw IDs with human-readable names via DB lookups
const enrichPayload = async (data) => {
  if (!data || typeof data !== "object") return data;
  const enriched = { ...data };

  try {
    // user_id / supervisor_id → name from users table
    const userIdVal = enriched.user_id || enriched.supervisor_id || enriched.userId || enriched.supervisorId;
    if (userIdVal) {
      const r = await pool.query("SELECT name FROM users WHERE user_id = $1", [userIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.user_id ? "user_id" : enriched.supervisor_id ? "supervisor_id" : enriched.userId ? "userId" : "supervisorId";
        enriched[key] = r.rows[0].name;
      }
    }

    // ward_id → ward_name from wards table
    const wardIdVal = enriched.ward_id || enriched.wardId;
    if (wardIdVal) {
      const r = await pool.query("SELECT ward_name FROM wards WHERE ward_id = $1", [wardIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.ward_id ? "ward_id" : "wardId";
        enriched[key] = r.rows[0].ward_name;
      }
    }

    // sector_id → sector_name from sectors table
    const sectorIdVal = enriched.sector_id || enriched.sectorId;
    if (sectorIdVal) {
      const r = await pool.query("SELECT sector_name FROM sectors WHERE sector_id = $1", [sectorIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.sector_id ? "sector_id" : "sectorId";
        enriched[key] = r.rows[0].sector_name;
      }
    }

    // city_id → city_name from cities table
    const cityIdVal = enriched.city_id || enriched.cityId;
    if (cityIdVal) {
      const r = await pool.query("SELECT city_name FROM cities WHERE city_id = $1", [cityIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.city_id ? "city_id" : "cityId";
        enriched[key] = r.rows[0].city_name;
      }
    }

    // zone_id → zone_name from zones table
    const zoneIdVal = enriched.zone_id || enriched.zoneId;
    if (zoneIdVal) {
      const r = await pool.query("SELECT zone_name FROM zones WHERE zone_id = $1", [zoneIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.zone_id ? "zone_id" : "zoneId";
        enriched[key] = r.rows[0].zone_name;
      }
    }

    // department_id → department_name from departments table
    const deptIdVal = enriched.department_id || enriched.departmentId;
    if (deptIdVal) {
      const r = await pool.query("SELECT department_name FROM departments WHERE department_id = $1", [deptIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.department_id ? "department_id" : "departmentId";
        enriched[key] = r.rows[0].department_name;
      }
    }

    // designation_id → designation_name from designations table
    const desigIdVal = enriched.designation_id || enriched.designationId;
    if (desigIdVal) {
      const r = await pool.query("SELECT designation_name FROM designations WHERE designation_id = $1", [desigIdVal]);
      if (r.rows.length > 0) {
        const key = enriched.designation_id ? "designation_id" : "designationId";
        enriched[key] = r.rows[0].designation_name;
      }
    }
  } catch (err) {
    // Enrichment errors must never break logging
    console.error("[AuditLogger] enrichPayload error (non-fatal):", err.message);
  }

  return enriched;
};


// extractIdFromUrl moved to the top of the file

// Helper to get human-readable description for specific route actions
const getActionDescription = (req, body, context = null) => {
  const method = req.method;
  const url = req.originalUrl || req.url;
  const id = extractIdFromUrl(url);

  // ── Auth Events ──
  if (url.includes("/api/auth/login") || url.includes("/api/auth/supervisor-login")) {
    return "Logged in successfully";
  }
  if (url.includes("/api/auth/logout")) {
    return "Logged out successfully";
  }
  if (url.includes("/api/auth/register")) {
    const role = req.body?.role || "user";
    return `Registered new ${role.charAt(0).toUpperCase() + role.slice(1)}: ${req.body?.name || req.body?.email || "unknown"}`;
  }
  if (url.includes("/api/auth/update")) {
    return `Updated account details for: ${req.body?.name || req.body?.email || "unknown"}`;
  }

  // ── Explicit Page View / Action Logging ──
  if (url.includes("/log-page-visit")) {
    return `Visited ${req.body?.pageName || "Unknown"} page`;
  }
  if (url.includes("/log-action")) {
    return req.body?.actionDescription || req.body?.actionName || "Performed custom action";
  }

  // ── Admin Management ──
  if (url.includes("/api/admin-management")) {
    if (method === "POST") return `Admin: Created new Admin account — ${req.body?.name || req.body?.email || "unknown"}`;
    if (method === "PUT") return `Admin: Updated Admin account ID: ${id || req.body?.user_id || "unknown"}`;
    if (method === "DELETE") return `Admin: Deleted Admin account ID: ${id || "unknown"}`;
  }

  // ── RBAC / Settings Page ──
  if (url.includes("/api/rbac/users")) {
    if (method === "PUT") {
      return `Settings: Updated permissions/access for user: ${req.body?.name || `ID ${id || "unknown"}`}`;
    }
    if (method === "DELETE") return `Settings: Revoked all permissions for user ID: ${id || "unknown"}`;
  }
  if (url.includes("/api/rbac/permissions")) {
    if (method === "POST") return `Settings: Created permission rule — Module: "${req.body?.module || "unknown"}", Action: "${req.body?.action || "unknown"}"`;
    if (method === "PUT") return `Settings: Updated permission rule ID: ${id || "unknown"}`;
    if (method === "DELETE") return `Settings: Deleted permission rule ID: ${id || "unknown"}`;
  }

  // ── Supervisor Management Page ──
  if (url.includes("/api/supervisor")) {
    const deletedSupervisor = context?.supervisor;
    if (method === "POST") return `Supervisor Management: Added new Supervisor - ${req.body?.name || req.body?.email || "unknown"}`;
    if (method === "PUT") return `Supervisor Management: Updated Supervisor - ${req.body?.name || req.body?.email || `ID ${id || "unknown"}`}`;
    if (method === "DELETE") {
      if (deletedSupervisor) {
        return `Supervisor Management: Deleted Supervisor - ${deletedSupervisor.name || deletedSupervisor.emp_code || `ID ${id || "unknown"}`} | City: ${deletedSupervisor.city_name || "N/A"} | Zone: ${deletedSupervisor.zone_name || "N/A"} | Ward: ${deletedSupervisor.ward_name || "N/A"} | Kothi: ${deletedSupervisor.kothi_name || "N/A"}`;
      }
      return `Supervisor Management: Deleted Supervisor ID: ${id || "unknown"}`;
    }
  }

  // ── Assign Supervisor to Ward/Kothi ──
  if (url.includes("/api/assignedWardRoutes") || url.includes("/api/assignedKothiRoutes")) {
    const wardAssignment = context?.supervisorWardAssignment;
    const kothiAssignment = context?.supervisorKothiAssignment;
    if (method === "POST") {
      const supName = req.body?.supervisorName || req.body?.name || "";
      const ward = req.body?.ward_name || req.body?.wardName || "";
      if (supName && ward) return `Assign Supervisor: Assigned Kothi "${ward}" to Supervisor: ${supName}`;
      if (supName) return `Assign Supervisor: Created ward/kothi assignment for: ${supName}`;
      return "Assign Supervisor: Created new ward/kothi assignment";
    }
    if (method === "PUT") return `Assign Supervisor: Updated ward/kothi assignment ID: ${id || "unknown"}`;
    if (method === "DELETE") {
      if (wardAssignment) {
        return `Assign Supervisor: Removed ward assignment - ${wardAssignment.name || wardAssignment.emp_code || "unknown"} | Kothi: ${wardAssignment.ward_name || "N/A"} | Zone: ${wardAssignment.zone_name || "N/A"} | City: ${wardAssignment.city_name || "N/A"}`;
      }
      if (kothiAssignment) {
        return `Assign Supervisor: Removed kothi assignment - ${kothiAssignment.name || kothiAssignment.emp_code || "unknown"} | Ward: ${kothiAssignment.ward_name || "N/A"} | Kothi: ${kothiAssignment.kothi_name || "N/A"} | Zone: ${kothiAssignment.zone_name || "N/A"} | City: ${kothiAssignment.city_name || "N/A"}`;
      }
      return `Assign Supervisor: Removed ward/kothi assignment ID: ${id || "unknown"}`;
    }
  }

  // ── Employee Management Page ──
  if (url.includes("/api/employees")) {
    const empName = req.body?.name || req.body?.emp_code || "";
    const deletedEmployee = context?.employee;
    if (url.includes("/aadhar") && method === "POST") {
      return `Employee Management: Uploaded Aadhar document for Employee ID: ${id || "unknown"}`;
    }
    if (method === "POST") return `Employee Management: Added new Employee - ${empName || "unknown"}`;
    if (method === "PUT") return `Employee Management: Updated Employee record - ${empName || `ID ${id || "unknown"}`}`;
    if (method === "DELETE") {
      if (deletedEmployee) {
        return `Employee Management: Deleted Employee - ${deletedEmployee.name || deletedEmployee.emp_code || `ID ${id || "unknown"}`} | City: ${deletedEmployee.city_name || "N/A"} | Zone: ${deletedEmployee.zone_name || "N/A"} | Ward: ${deletedEmployee.sector_name || "N/A"} | Kothi: ${deletedEmployee.ward_name || "N/A"}`;
      }
      return `Employee Management: Deleted Employee ID: ${id || "unknown"}`;
    }
  }

  // ── GeoFencing Page ──
  if (url.includes("/api/geofencing")) {
    const name = req.body?.name || req.body?.ward_name || req.body?.kothi_name || req.body?.kothiName || "";
    if (url.includes("/approve")) return `GeoFencing: Approved GeoFence request${name ? ` for: ${name}` : ""}`;
    if (url.includes("/reject")) return `GeoFencing: Rejected GeoFence request${name ? ` for: ${name}` : ""}`;
    if (method === "POST") return `GeoFencing: Created new GeoFence boundary${name ? ` for: ${name}` : ""}`;
    if (method === "PUT") return `GeoFencing: Updated GeoFence configuration${name ? ` for: ${name}` : ` ID: ${id || "unknown"}`}`;
    if (method === "DELETE") return `GeoFencing: Deleted GeoFence configuration ID: ${id || "unknown"}`;
  }

  // ── Communication Hub (Announcements & Feedback) ──
  if (url.includes("/announcements")) {
    const title = req.body?.title || "";
    if (method === "POST") return `Communication Hub: Created Announcement — "${title || "untitled"}"`;
    if (method === "PUT") return `Communication Hub: Updated Announcement${title ? ` — "${title}"` : ` ID: ${id || "unknown"}`}`;
    if (method === "DELETE") return `Communication Hub: Deleted Announcement ID: ${id || "unknown"}`;
  }
  if (url.includes("/feedback")) {
    const q = (req.body?.question || "").substring(0, 60);
    if (method === "POST") return `Communication Hub: Added Feedback question — "${q || "untitled"}"`;
    if (method === "PUT") return `Communication Hub: Updated Feedback question ID: ${id || "unknown"}`;
    if (method === "DELETE") return `Communication Hub: Deleted Feedback question ID: ${id || "unknown"}`;
  }

  // ── Master Setup — Cities ──
  if (url.includes("/api/cities")) {
    const name = req.body?.city_name || req.body?.name || "";
    const deletedCity = context?.city;
    if (method === "POST") return `Master Setup (Cities): Added new City - "${name || "unknown"}"`;
    if (method === "PUT") return `Master Setup (Cities): Updated City - "${name || `ID ${id || "unknown"}`}"`;
    if (method === "DELETE") {
      if (deletedCity) {
        return `Master Setup (Cities): Deleted City - ${deletedCity.city_name || `ID ${id || "unknown"}`} | State: ${deletedCity.state || "N/A"}`;
      }
      return `Master Setup (Cities): Deleted City ID: ${id || "unknown"}`;
    }
  }

  // ── Master Setup — Zones ──
  if (url.includes("/api/zones")) {
    const name = req.body?.zone_name || req.body?.name || "";
    const deletedZone = context?.zone;
    if (url.includes("/merge")) return `Master Setup (Zones): Merged Zones (target ID: ${req.body?.targetZoneId || "unknown"})`;
    if (method === "POST") return `Master Setup (Zones): Added new Zone - "${name || "unknown"}"`;
    if (method === "PUT") return `Master Setup (Zones): Updated Zone - "${name || `ID ${id || "unknown"}`}"`;
    if (method === "DELETE") {
      if (deletedZone) {
        return `Master Setup (Zones): Deleted Zone - ${deletedZone.zone_name || `ID ${id || "unknown"}`} | City: ${deletedZone.city_name || "N/A"}`;
      }
      return `Master Setup (Zones): Deleted Zone ID: ${id || "unknown"}`;
    }
  }

  // ── Master Setup — Wards / Sectors ──
  if (url.includes("/api/sectors")) {
    const name = req.body?.sector_name || req.body?.sectorName || req.body?.name || "";
    const deletedWard = context?.ward;
    if (method === "POST") return `Master Setup (Wards): Added new Ward - "${name || "unknown"}"`;
    if (method === "PUT") return `Master Setup (Wards): Updated Ward - "${name || `ID ${id || "unknown"}`}"`;
    if (method === "DELETE") {
      if (deletedWard) {
        return `Master Setup (Wards): Deleted Ward - ${deletedWard.sector_name || `ID ${id || "unknown"}`} | Zone: ${deletedWard.zone_name || "N/A"} | City: ${deletedWard.city_name || "N/A"} | Kothis: ${deletedWard.kothi_count ?? 0}`;
      }
      return `Master Setup (Wards): Deleted Ward ID: ${id || "unknown"}`;
    }
  }

  // ── Master Setup — Kothi (sub-ward) ──
  if (url.includes("/api/wards")) {
    const name = req.body?.ward_name || req.body?.wardName || req.body?.name || "";
    const deletedKothi = context?.kothi;
    if (method === "POST") return `Master Setup (Kothi): Added new Kothi - "${name || "unknown"}"`;
    if (method === "PUT") return `Master Setup (Kothi): Updated Kothi - "${name || `ID ${id || "unknown"}`}"`;
    if (method === "DELETE") {
      if (deletedKothi) {
        return `Master Setup (Kothi): Deleted Kothi - ${deletedKothi.ward_name || `ID ${id || "unknown"}`} | Ward: ${deletedKothi.sector_name || "N/A"} | Zone: ${deletedKothi.zone_name || "N/A"} | City: ${deletedKothi.city_name || "N/A"}`;
      }
      return `Master Setup (Kothi): Deleted Kothi ID: ${id || "unknown"}`;
    }
  }

  // ── Master Setup — Departments ──
  if (url.includes("/api/departments")) {
    const name = req.body?.department_name || req.body?.departmentName || req.body?.name || "";
    const deletedDepartment = context?.department;
    if (method === "POST") return `Master Setup (Departments): Added new Department - "${name || "unknown"}"`;
    if (method === "PUT") return `Master Setup (Departments): Updated Department - "${name || `ID ${id || "unknown"}`}"`;
    if (method === "DELETE") {
      if (deletedDepartment) {
        return `Master Setup (Departments): Deleted Department - ${deletedDepartment.department_name || `ID ${id || "unknown"}`}`;
      }
      return `Master Setup (Departments): Deleted Department ID: ${id || "unknown"}`;
    }
  }

  // ── Master Setup — Designations ──
  if (url.includes("/api/designations")) {
    const name = req.body?.designation_name || req.body?.designationName || req.body?.name || "";
    const deletedDesignation = context?.designation;
    if (method === "POST") return `Master Setup (Designations): Added new Designation - "${name || "unknown"}"`;
    if (method === "PUT") return `Master Setup (Designations): Updated Designation - "${name || `ID ${id || "unknown"}`}"`;
    if (method === "DELETE") {
      if (deletedDesignation) {
        return `Master Setup (Designations): Deleted Designation - ${deletedDesignation.designation_name || `ID ${id || "unknown"}`} | Department: ${deletedDesignation.department_name || "N/A"}`;
      }
      return `Master Setup (Designations): Deleted Designation ID: ${id || "unknown"}`;
    }
  }

  // ── Master Setup — Employee Migration ──
  if (url.includes("/migration") || url.includes("/employee-migration")) {
    if (method === "POST") return "Master Setup (Migration): Performed Employee Data Migration";
  }

  // ── Generic Fallback ──
  const verb =
    method === "POST" ? "Added record to" :
    method === "PUT" ? "Updated record in" :
    method === "DELETE" ? "Deleted record from" : "Performed action on";
  return `${verb}: ${url.split("?")[0]}`;
};

// Async function to handle logging in the background
async function logRequest(req, res, responseBody) {
  try {
    const timestamp = new Date().toISOString();
    let ip =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-real-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      req.ip;

    if (ip && ip.includes(",")) {
      ip = ip.split(",")[0].trim();
    }

    if (ip === "::1" || ip === "::ffff:127.0.0.1") {
      ip = "127.0.0.1";
    }

    const device = parseUserAgent(req.headers["user-agent"]);

    let actor = {
      user_id: null,
      email: "guest@matrixtrack.in",
      name: "Guest / System",
      role: "guest",
    };

    // 1. Resolve User Details
    if (req.user && req.user.user_id) {
      // Authenticated route - pull full profile from DB
      const userRes = await pool.query(
        "SELECT name, email, role FROM users WHERE user_id = $1",
        [req.user.user_id]
      );
      if (userRes.rows.length > 0) {
        actor = {
          user_id: req.user.user_id,
          email: userRes.rows[0].email,
          name: userRes.rows[0].name,
          role: userRes.rows[0].role,
        };
      }
    } else {
      // Try decoding JWT token directly from cookies/headers if req.user is not yet populated
      const jwt = require("jsonwebtoken");
      const bearer = req.header("Authorization") || req.header("authorization") || "";
      const headerToken = bearer.startsWith("Bearer ") ? bearer.split(" ")[1] : bearer || null;
      const fallbackHeader = req.header("x-access-token") || req.header("token");
      const queryToken = req.query?.token;
      const token =
        (req.cookies && req.cookies.token) || headerToken || fallbackHeader || queryToken;

      let decodedUserId = null;
      if (token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          decodedUserId = decoded?.user_id;
        } catch (err) {
          // Token invalid or expired - ignore
        }
      }

      if (decodedUserId) {
        const userRes = await pool.query(
          "SELECT name, email, role FROM users WHERE user_id = $1",
          [decodedUserId]
        );
        if (userRes.rows.length > 0) {
          actor = {
            user_id: decodedUserId,
            email: userRes.rows[0].email,
            name: userRes.rows[0].name,
            role: userRes.rows[0].role,
          };
        }
      } else if (responseBody && responseBody.user) {
        // Login route - user is not authenticated yet but body contains user profile
        actor = {
          user_id: responseBody.user.user_id,
          email: responseBody.user.email,
          name: responseBody.user.name,
          role: responseBody.user.role,
        };
      } else if (req.body && req.body.email) {
        // Failed login attempt or guest submission with email
        actor.email = req.body.email;
      }
    }

    const rawPayload = maskPayload(req.body);
    const deleteContext = req._deleteContext || null;
    const contextPayload =
      deleteContext?.employee
        ? {
            ...rawPayload,
            deleted_employee_name: deleteContext.employee.name,
            deleted_employee_emp_code: deleteContext.employee.emp_code,
            city_name: deleteContext.employee.city_name,
            zone_name: deleteContext.employee.zone_name,
            ward_name: deleteContext.employee.sector_name,
            kothi_name: deleteContext.employee.ward_name,
            delete_context: deleteContext,
          }
        : deleteContext
          ? {
              ...rawPayload,
              delete_context: deleteContext,
            }
          : rawPayload;
    const enrichedPayload = await enrichPayload(contextPayload);

    const envScope = getEnvironmentScope();

    const logObject = {
      timestamp,
      actor,
      action: {
        description: getActionDescription(req, responseBody, deleteContext),
        method: req.method,
        url: req.originalUrl || req.url,
        payload: enrichedPayload,
      },
      client: {
        ip,
        device,
      },
      environment: {
        db_host: envScope.dbHost,
        db_name: envScope.dbName,
        scope_key: envScope.scopeKey,
      },
    };

    // Upload log to S3 in the background (non-blocking)
    await uploadAuditLog(logObject);
  } catch (error) {
    console.error("[AuditLogger] Background logging error:", error.message);
  }
}

module.exports = async (req, res, next) => {
  const isModifying = ["POST", "PUT", "DELETE"].includes(req.method);
  const requestPath = req.originalUrl || req.url || "";
  const normalizedPath = requestPath.split("?")[0];
  const isAuditableRoute =
    AUDITABLE_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix)) ||
    AUDITABLE_AUTH_PATHS.has(normalizedPath);

  if (!isModifying || !isAuditableRoute) {
    return next();
  }

  if (req.method === "DELETE") {
    try {
      req._deleteContext = await fetchDeleteContext(req);
    } catch (err) {
      console.error("[AuditLogger] Error fetching pre-delete context:", err.message);
    }
  }

  const originalJson = res.json;
  res.json = function (body) {
    originalJson.apply(this, arguments);

    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        logRequest(req, res, body);
      }
    } catch (err) {
      console.error("[AuditLogger] Interceptor handling error:", err.message);
    }
  };

  next();
};





