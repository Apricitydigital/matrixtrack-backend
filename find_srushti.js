const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgresql',
    host: process.env.DB_HOST || 'database-1.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
    database: process.env.DB_NAME || 'attendEase',
    port: process.env.DB_PORT || 5432,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    try {
        console.log("--- 1. Searching in users table ---");
        const usersRes = await pool.query(`
      SELECT user_id, email, name, role, phone, is_active, created_at
      FROM users 
      WHERE name ILIKE '%srushti%' OR email ILIKE '%srushti%' OR name ILIKE '%wadekar%'
    `);
        console.log("Users found:", usersRes.rows);

        console.log("\n--- 2. Searching in self_punch_requests table ---");
        const selfPunchRes = await pool.query(`
      SELECT *
      FROM self_punch_requests
      WHERE full_name ILIKE '%srushti%' OR mobile_number ILIKE '%srushti%' OR full_name ILIKE '%wadekar%'
      ORDER BY created_at DESC
    `);
        console.log("Self Punch Requests found:", selfPunchRes.rows);

        console.log("\n--- 3. Checking all tables in public schema containing 'professional', 'punch', 'attendance', 'self', 'employee' ---");
        const tablesRes = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
        const tables = tablesRes.rows.map(r => r.table_name);
        console.log("All tables:", tables.join(", "));

        // Search all tables for 'srushti'
        for (const table of tables) {
            const colsRes = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = $1 AND table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'character')
      `, [table]);
            const textCols = colsRes.rows.map(c => c.column_name);
            if (textCols.length > 0) {
                const whereClause = textCols.map(col => `"${col}" ILIKE '%srushti%' OR "${col}" ILIKE '%wadekar%'`).join(" OR ");
                try {
                    const searchRes = await pool.query(`SELECT * FROM "${table}" WHERE ${whereClause} LIMIT 20`);
                    if (searchRes.rows.length > 0) {
                        console.log(`\nFound matches in table "${table}":`, searchRes.rows);
                    }
                } catch (e) {
                    // ignore column query errors
                }
            }
        }

    } catch (err) {
        console.error("Database query error:", err);
    } finally {
        await pool.end();
    }
}

main();
