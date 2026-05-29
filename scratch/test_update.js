const pool = require("../config/db");

async function test() {
    try {
        const designationId = 13; // Gardener from my previous test
        const cityIds = [1]; // Indore
        
        console.log("Updating designation 13 with city 1...");
        
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM designation_cities WHERE designation_id = $1", [designationId]);
            await client.query("INSERT INTO designation_cities (designation_id, city_id) VALUES ($1, $2)", [designationId, 1]);
            await client.query("COMMIT");
            console.log("Update successful");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }

        console.log("\nFetching again...");
        const result = await pool.query(`
            SELECT d.*, dept.department_name, ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL) as city_ids
            FROM designation d
            JOIN department dept ON d.department_id = dept.department_id
            LEFT JOIN designation_cities dc ON d.designation_id = dc.designation_id
            WHERE d.designation_id = $1
            GROUP BY d.designation_id, dept.department_name
        `, [designationId]);
        
        console.log(JSON.stringify(result.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit(0);
    }
}

test();
