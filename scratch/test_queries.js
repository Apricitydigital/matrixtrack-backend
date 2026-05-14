const pool = require("../config/db");

async function test() {
    try {
        console.log("--- Departments ---");
        const depts = await pool.query(`
            SELECT d.*, ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL) as city_ids
            FROM department d
            LEFT JOIN department_cities dc ON d.department_id = dc.department_id
            GROUP BY d.department_id
            LIMIT 5
        `);
        console.log(JSON.stringify(depts.rows, null, 2));

        console.log("\n--- Designations ---");
        const desigs = await pool.query(`
            SELECT d.*, dept.department_name, ARRAY_AGG(dc.city_id) FILTER (WHERE dc.city_id IS NOT NULL) as city_ids
            FROM designation d
            JOIN department dept ON d.department_id = dept.department_id
            LEFT JOIN designation_cities dc ON d.designation_id = dc.designation_id
            GROUP BY d.designation_id, dept.department_name
            LIMIT 5
        `);
        console.log(JSON.stringify(desigs.rows, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        process.exit(0);
    }
}

test();
