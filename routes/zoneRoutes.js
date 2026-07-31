const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize, getPermissionCityFilter } = require("../middleware/permissionMiddleware");
const { attachCityScope, requireCityScope } = require("../middleware/cityScope");
const { attachZoneScope } = require("../middleware/zoneScope");
const { attachKothiScope } = require("../middleware/kothiScope");
const { mergeZones } = require("../utils/mergeZones");

// 🟢 Fetch all zones with city names
router.get(
  "/",
  authenticate,
  attachKothiScope,
  attachZoneScope,
  attachCityScope,
  requireCityScope(true),
  async (req, res) => {
    try {
      const scope = req.cityScope || { all: false, ids: [] };
      const kothiScope = req.kothiScope || { all: true, ids: [] };
      const params = [];
      let whereClause = "";

      if (!scope.all) {
        params.push(scope.ids);
        whereClause = 'WHERE c.city_id = ANY($' + params.length + ')';
      }

      if (req.query.cityId) {
        const ids = String(req.query.cityId)
          .split(",")
          .map((id) => Number(id.trim()))
          .filter((id) => Number.isFinite(id));
        if (ids.length > 0) {
          params.push(ids);
          whereClause += whereClause ? ' AND c.city_id = ANY($' + params.length + ')' : 'WHERE c.city_id = ANY($' + params.length + ')';
        }
      }

      // Kothi (Ward) Scope Filtering
      if (!kothiScope.all && kothiScope.ids.length > 0) {
        params.push(kothiScope.ids);
        whereClause += whereClause 
          ? ' AND z.zone_id IN (SELECT DISTINCT zone_id FROM wards WHERE ward_id = ANY($' + params.length + '))' 
          : 'WHERE z.zone_id IN (SELECT DISTINCT zone_id FROM wards WHERE ward_id = ANY($' + params.length + '))';
      } else if (!kothiScope.all) {
        // No Kothis assigned, return nothing
        whereClause += whereClause ? " AND 1=0" : "WHERE 1=0";
      }

      const result = await pool.query(
        `
      SELECT z.zone_id, z.zone_name, c.city_id, c.city_name
      FROM zones z
      JOIN cities c ON z.city_id = c.city_id
      ${whereClause}
      ORDER BY z.zone_id ASC
    `,
        params
      );
      const allowedCities = getPermissionCityFilter(req, "city", "view");
      const zoneScope = req.zoneScope || { all: true, ids: [] };
      let rows = result.rows;
      if (Array.isArray(allowedCities) && allowedCities.length > 0) {
        const allowedSet = new Set(
          allowedCities.map((cityId) => Number(cityId))
        );
        rows = rows.filter((row) => allowedSet.has(Number(row.city_id)));
      }
      if (!zoneScope.all) {
        const allowedZones = Array.isArray(zoneScope.ids)
          ? zoneScope.ids
              .map((zoneId) => Number(zoneId))
              .filter((zoneId) => Number.isFinite(zoneId))
          : [];
        const allowedZoneSet = new Set(allowedZones);
        rows = rows.filter((row) => allowedZoneSet.has(Number(row.zone_id)));
      }
      res.json(rows);
    } catch (error) {
      console.error("Error fetching zones:", error);
      res.status(500).json({ error: "Database error" });
    }
  }
);

// 🟢 Add a new zone
router.post(
  "/",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { zone_name, city_id } = req.body;
  if (!zone_name || !city_id) {
    return res
      .status(400)
      .json({ error: "Zone name and city ID are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO zones (zone_name, city_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [zone_name, city_id]
    );

    if (result.rowCount === 0) {
      console.warn("Record exists, skipping");
      const existing = await pool.query(
        `SELECT * FROM zones WHERE zone_name = $1 AND city_id = $2 LIMIT 1`,
        [zone_name, city_id]
      );
      return res
        .status(200)
        .json(existing.rows[0] || { message: "Record exists, skipping" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error adding zone:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Edit a zone
router.put(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
  const { id } = req.params;
  const { zone_name } = req.body;

  try {
    const result = await pool.query(
      `UPDATE zones SET zone_name = $1 WHERE zone_id = $2 RETURNING *`,
      [zone_name, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Zone not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error updating zone:", error);
    res.status(500).json({ error: "Database error" });
  }
  }
);

// 🟢 Delete a zone
router.delete(
  "/:id",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    const safeExec = async (sql, params = []) => {
      try {
        await client.query("SAVEPOINT sp");
        await client.query(sql, params);
        await client.query("RELEASE SAVEPOINT sp");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT sp");
      }
    };

    try {
      await client.query("BEGIN");

      // Check if zone exists
      const zoneCheck = await client.query("SELECT zone_id FROM zones WHERE zone_id = $1", [id]);
      if (zoneCheck.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Zone not found" });
      }

      // 1. Get linked ward IDs & sector IDs
      const wardRows = await client.query("SELECT ward_id FROM wards WHERE zone_id = $1", [id]);
      const wardIds = wardRows.rows.map((r) => r.ward_id);

      const sectorRows = await client.query("SELECT sector_id FROM sectors WHERE zone_id = $1", [id]);
      const sectorIds = sectorRows.rows.map((r) => r.sector_id);

      // 2. Identify supervisors linked to this zone (via user_zone_access or via wards)
      let supervisorQuery = `
        SELECT DISTINCT u.user_id 
        FROM users u
        WHERE u.role = 'supervisor' AND (
          EXISTS (SELECT 1 FROM user_zone_access uza WHERE uza.user_id = u.user_id AND uza.zone_id = $1)
      `;
      if (wardIds.length > 0) {
        supervisorQuery += `
          OR EXISTS (SELECT 1 FROM supervisor_ward sw WHERE sw.supervisor_id = u.user_id AND sw.ward_id = ANY($2::int[]))
          OR EXISTS (SELECT 1 FROM supervisor_kothi sk WHERE sk.supervisor_id = u.user_id AND sk.ward_id = ANY($2::int[]))
          OR EXISTS (SELECT 1 FROM user_kothi_access uka WHERE uka.user_id = u.user_id AND uka.ward_id = ANY($2::int[]))
        `;
      }
      supervisorQuery += `)`;
      
      const supervisorParams = wardIds.length > 0 ? [id, wardIds] : [id];
      const supRes = await client.query(supervisorQuery, supervisorParams);
      const supervisorIds = supRes.rows.map((r) => r.user_id);

      // 3. Clean professional dependencies (logs, requests, notifications, tokens)
      await safeExec(
        "DELETE FROM professional_leave_request_logs WHERE actor_professional_id IN (SELECT id FROM professional_employees WHERE zone_id = $1 OR (ward_id IS NOT NULL AND ward_id = ANY($2::int[])))",
        [id, wardIds.length > 0 ? wardIds : [-1]]
      );
      await safeExec(
        "DELETE FROM professional_leave_requests WHERE professional_id IN (SELECT id FROM professional_employees WHERE zone_id = $1 OR (ward_id IS NOT NULL AND ward_id = ANY($2::int[])))",
        [id, wardIds.length > 0 ? wardIds : [-1]]
      );
      await safeExec(
        "DELETE FROM professional_notifications WHERE professional_id IN (SELECT id FROM professional_employees WHERE zone_id = $1 OR (ward_id IS NOT NULL AND ward_id = ANY($2::int[])))",
        [id, wardIds.length > 0 ? wardIds : [-1]]
      );
      await safeExec(
        "DELETE FROM professional_push_tokens WHERE professional_id IN (SELECT id FROM professional_employees WHERE zone_id = $1 OR (ward_id IS NOT NULL AND ward_id = ANY($2::int[])))",
        [id, wardIds.length > 0 ? wardIds : [-1]]
      );

      // Clean professional attendance and employees
      if (wardIds.length > 0) {
        await safeExec("DELETE FROM professional_attendance WHERE zone_id = $1 OR ward_id = ANY($2::int[])", [id, wardIds]);
        await safeExec("DELETE FROM professional_employees WHERE zone_id = $1 OR ward_id = ANY($2::int[])", [id, wardIds]);
      } else {
        await safeExec("DELETE FROM professional_attendance WHERE zone_id = $1", [id]);
        await safeExec("DELETE FROM professional_employees WHERE zone_id = $1", [id]);
      }

      // Clean self-punch requests & standard attendance
      if (wardIds.length > 0) {
        await safeExec("DELETE FROM attendance WHERE ward_id = ANY($1::int[])", [wardIds]);
        await safeExec("DELETE FROM self_punch_requests WHERE zone_id = $1 OR ward_id = ANY($2::int[])", [id, wardIds]);
        await safeExec("DELETE FROM employee WHERE ward_id = ANY($1::int[])", [wardIds]);
      } else {
        await safeExec("DELETE FROM self_punch_requests WHERE zone_id = $1", [id]);
      }

      if (wardIds.length > 0 || sectorIds.length > 0) {
        await safeExec(
          "DELETE FROM professional_holidays WHERE zone_id = $1 OR (ward_id IS NOT NULL AND ward_id = ANY($2::int[])) OR (kothi_id IS NOT NULL AND kothi_id = ANY($3::int[]))",
          [id, sectorIds.length > 0 ? sectorIds : [-1], wardIds.length > 0 ? wardIds : [-1]]
        );
      } else {
        await safeExec("DELETE FROM professional_holidays WHERE zone_id = $1", [id]);
      }

      // 4. Soft-delete supervisors linked to this zone
      if (supervisorIds.length > 0) {
        await safeExec(
          "UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE user_id = ANY($1::int[])",
          [supervisorIds]
        );
      }

      // 5. Delete supervisor access & assignments
      await safeExec("DELETE FROM user_zone_access WHERE zone_id = $1", [id]);
      if (wardIds.length > 0) {
        await safeExec("DELETE FROM supervisor_ward WHERE ward_id = ANY($1::int[])", [wardIds]);
        await safeExec("DELETE FROM supervisor_kothi WHERE ward_id = ANY($1::int[])", [wardIds]);
        await safeExec("DELETE FROM user_kothi_access WHERE ward_id = ANY($1::int[])", [wardIds]);
      }

      // 6. Clean up geofencing and transfer histories
      if (wardIds.length > 0) {
        await safeExec("DELETE FROM geofencing WHERE zone_id = $1 OR ward_id = ANY($2::int[])", [id, wardIds]);
        await safeExec("DELETE FROM geofencing_requests WHERE zone_id = $1 OR ward_id = ANY($2::int[])", [id, wardIds]);
      } else {
        await safeExec("DELETE FROM geofencing WHERE zone_id = $1", [id]);
        await safeExec("DELETE FROM geofencing_requests WHERE zone_id = $1", [id]);
      }

      await safeExec(
        "DELETE FROM employee_transfer_history WHERE from_zone_id = $1 OR to_zone_id = $1 OR (from_kothi_id IS NOT NULL AND from_kothi_id = ANY($2::int[])) OR (to_kothi_id IS NOT NULL AND to_kothi_id = ANY($2::int[]))",
        [id, wardIds.length > 0 ? wardIds : [-1]]
      );

      await safeExec(
        "DELETE FROM supervisor_transfer_history WHERE from_zone_id = $1 OR to_zone_id = $1 OR (from_kothi_id IS NOT NULL AND from_kothi_id = ANY($2::int[])) OR (to_kothi_id IS NOT NULL AND to_kothi_id = ANY($2::int[]))",
        [id, wardIds.length > 0 ? wardIds : [-1]]
      );

      // 7. Delete Wards & Sectors
      if (wardIds.length > 0) {
        await safeExec("DELETE FROM wards WHERE ward_id = ANY($1::int[])", [wardIds]);
      }
      if (sectorIds.length > 0) {
        await safeExec("DELETE FROM sectors WHERE sector_id = ANY($1::int[])", [sectorIds]);
      }

      // 8. Delete Zone
      await safeExec("DELETE FROM zones WHERE zone_id = $1", [id]);

      await client.query("COMMIT");
      res.json({
        message: "Zone and all associated employees, supervisors, wards, and data deleted successfully",
        deletedEmployeesCount: wardIds.length,
        deletedSupervisorsCount: supervisorIds.length,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Error deleting zone:", error);
      res.status(500).json({ error: "Failed to delete zone: " + error.message });
    } finally {
      client.release();
    }
  }
);

// 🟢 Merge zones (merge duplicate zones into a single target)
router.post(
  "/merge",
  authenticate,
  authorize("master", "manage"),
  async (req, res) => {
    try {
      const { targetZoneId, sourceZoneIds, rename, dryRun, force, autoResolve } = req.body || {};
      const target = Number(targetZoneId);
      const sources = Array.isArray(sourceZoneIds)
        ? sourceZoneIds.map((z) => Number(z)).filter(Number.isFinite)
        : String(sourceZoneIds || "")
            .split(",")
            .map((z) => Number(z.trim()))
            .filter(Number.isFinite);

      if (!target || !sources.length) {
        return res.status(400).json({ error: "targetZoneId and sourceZoneIds are required." });
      }

      const result = await mergeZones({
        target,
        source: sources,
        rename: rename || null,
        dryRun: Boolean(dryRun),
        force: Boolean(force),
        autoResolve: Boolean(autoResolve),
      });

      res.json({
        executed: result.executed,
        plan: result.plan,
        message: result.executed ? "Merge completed." : "Dry run only.",
      });
    } catch (error) {
      console.error("Error merging zones:", error);
      res.status(400).json({
        error: error.message || "Unable to merge zones.",
        details: error.details || null,
      });
    }
  }
);

module.exports = router;
