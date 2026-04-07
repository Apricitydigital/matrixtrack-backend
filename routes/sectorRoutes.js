const express = require("express");
const router = express.Router();
const pool = require("../config/db");
const authenticate = require("../middleware/authMiddleware");
const { authorize } = require("../middleware/permissionMiddleware");
const {
    attachCityScope,
    requireCityScope,
    buildCityFilterClause,
} = require("../middleware/cityScope");
const { attachKothiScope, buildKothiFilterClause } = require("../middleware/kothiScope");

// Get all sectors (Wards) with associated Kothis, filtered by city scope
router.get(
    "/",
    authenticate,
    attachKothiScope,
    attachCityScope,
    requireCityScope(),
    async (req, res) => {
        try {
            const scope = req.cityScope || { all: false, ids: [] };
            const kothiScope = req.kothiScope || { all: true, ids: [] };
            
            const cityFilter = buildCityFilterClause(scope, "c", []);
            const kothiFilter = buildKothiFilterClause(kothiScope, "w", cityFilter.params);

            const result = await pool.query(
                `SELECT 
            s.sector_id, s.sector_name,
            z.zone_id, z.zone_name,
            c.city_id, c.city_name,
            w.ward_id, w.ward_name
         FROM sectors s
         JOIN zones z ON s.zone_id = z.zone_id
         JOIN cities c ON z.city_id = c.city_id
         LEFT JOIN wards w ON w.sector_id = s.sector_id
         ${cityFilter.clause} ${kothiFilter.clause}
         ORDER BY c.city_name, z.zone_name, s.sector_name, w.ward_name`,
                kothiFilter.params
            );

            const groupedData = {};
            result.rows.forEach((row) => {
                const { city_id, city_name, zone_id, zone_name, sector_id, sector_name, ward_id, ward_name } = row;

                if (!groupedData[city_id]) {
                    groupedData[city_id] = { cityId: city_id, city: city_name, zones: {} };
                }
                if (!groupedData[city_id].zones[zone_id]) {
                    groupedData[city_id].zones[zone_id] = { zoneId: zone_id, zone: zone_name, sectors: {} };
                }
                if (!groupedData[city_id].zones[zone_id].sectors[sector_id]) {
                    groupedData[city_id].zones[zone_id].sectors[sector_id] = {
                        sectorId: sector_id,
                        sectorName: sector_name,
                        kothis: [],
                    };
                }

                if (ward_id) {
                    groupedData[city_id].zones[zone_id].sectors[sector_id].kothis.push({
                        wardId: ward_id,
                        wardName: ward_name,
                    });
                }
            });

            const response = Object.values(groupedData).map((city) => ({
                ...city,
                zones: Object.values(city.zones).map((zone) => ({
                    ...zone,
                    sectors: Object.values(zone.sectors),
                })),
            }));

            res.json(response);
        } catch (error) {
            console.error("Error fetching sectors:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

// Create a new sector (Ward) and assign multiple wards (Kothis)
router.post("/", authenticate, authorize("master", "manage"), async (req, res) => {
    const { sector_name, zone_id, ward_ids } = req.body; // ward_ids is an array
    if (!sector_name || !zone_id) {
        return res.status(400).json({ error: "Sector name and Zone ID are required" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Create the sector
        const sectorResult = await client.query(
            `INSERT INTO sectors (sector_name, zone_id) 
             VALUES ($1, $2) 
             ON CONFLICT (sector_name, zone_id) DO UPDATE SET sector_name = EXCLUDED.sector_name
             RETURNING *`,
            [sector_name, zone_id]
        );
        const sector = sectorResult.rows[0];

        // 2. Assign wards to this sector
        if (Array.isArray(ward_ids) && ward_ids.length > 0) {
            await client.query(
                `UPDATE wards SET sector_id = $1 WHERE ward_id = ANY($2::int[])`,
                [sector.sector_id, ward_ids]
            );
        }

        await client.query("COMMIT");
        res.status(201).json(sector);
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error creating sector:", error);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

// Update a sector and its ward assignments
router.put("/:id", authenticate, authorize("master", "manage"), async (req, res) => {
    const { id } = req.params;
    const { sector_name, zone_id, ward_ids } = req.body;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Update sector name/zone
        const result = await client.query(
            `UPDATE sectors SET sector_name = $1, zone_id = $2 WHERE sector_id = $3 RETURNING *`,
            [sector_name, zone_id, id]
        );
        if (result.rowCount === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Sector not found" });
        }

        // 2. Reset existing assignments for this sector
        await client.query(`UPDATE wards SET sector_id = NULL WHERE sector_id = $1`, [id]);

        // 3. Set new assignments
        if (Array.isArray(ward_ids) && ward_ids.length > 0) {
            await client.query(
                `UPDATE wards SET sector_id = $1 WHERE ward_id = ANY($2::int[])`,
                [id, ward_ids]
            );
        }

        await client.query("COMMIT");
        res.json(result.rows[0]);
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error updating sector:", error);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        client.release();
    }
});

// Delete a sector
router.delete("/:id", authenticate, authorize("master", "manage"), async (req, res) => {
    const { id } = req.params;
    try {
        // wards table handles ON DELETE SET NULL if we set it up that way, otherwise manual nulling
        await pool.query("UPDATE wards SET sector_id = NULL WHERE sector_id = $1", [id]);
        const result = await pool.query("DELETE FROM sectors WHERE sector_id = $1 RETURNING *", [id]);
        if (result.rowCount === 0) return res.status(404).json({ error: "Sector not found" });
        res.json({ message: "Sector deleted successfully" });
    } catch (error) {
        console.error("Error deleting sector:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = router;
