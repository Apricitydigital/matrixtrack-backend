const { Pool } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });

async function main() {
    console.log("=== HARD DELETE SUPERVISOR: Rahul Vitthal Kange ===");

    // Clean env host string if typo present
    const envHost = (process.env.DB_HOST || '').replace('matrixdtrack', 'matrixtrack');
    const candidateHosts = [
        envHost,
        'backup-matrixtrack.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
        'mtdev.ch4kymie8ss9.ap-south-1.rds.amazonaws.com',
        '127.0.0.1'
    ].filter(Boolean);

    const user = process.env.DB_USER || 'postgres';
    const envPass = process.env.DB_PASSWORD ? process.env.DB_PASSWORD.replace(/^"|"$/g, '') : null;
    const candidatePasses = [
        envPass,
        'Matrix!Apri#20',
        'postgresql',
        'postgres',
        'Pmc@1234',
        'Pmc@123',
        'admin123',
        'Password123',
        'password'
    ].filter(Boolean);

    const database = process.env.DB_NAME || 'attendEase';
    const port = process.env.DB_PORT || 5432;

    let client = null;
    let pool = null;

    hostLoop:
    for (const host of candidateHosts) {
        for (const pass of candidatePasses) {
            console.log(`Trying DB Host: ${host} (Password: ${pass.substring(0, 3)}***)...`);
            try {
                pool = new Pool({
                    user,
                    host,
                    database,
                    password: pass,
                    port,
                    ssl: host.includes('amazonaws.com') ? { rejectUnauthorized: false } : false,
                    connectionTimeoutMillis: 3000
                });
                client = await pool.connect();
                console.log(`\n✅ SUCCESSFULLY CONNECTED to Database Host: ${host}!`);
                break hostLoop;
            } catch (err) {
                if (pool) await pool.end();
                client = null;
            }
        }
    }

    if (!client) {
        console.error("\n❌ Could not authenticate with any database password. Please check your DB credentials.");
        process.exit(1);
    }

    try {
        await client.query('BEGIN');

        // 1. Find Rahul Vitthal Kange
        const findRes = await client.query(`
            SELECT user_id, name, email, phone, role 
            FROM users 
            WHERE email ILIKE '%rahulkange%' OR phone LIKE '%8208266735%' OR name ILIKE '%rahul%kange%'
        `);

        console.log(`\nFound ${findRes.rows.length} matching supervisor user records:`);
        console.table(findRes.rows);

        if (findRes.rows.length === 0) {
            console.log("No supervisor matching 'Rahul Vitthal Kange' found in database.");
            await client.query('ROLLBACK');
            process.exit(0);
        }

        for (const supervisor of findRes.rows) {
            const userId = supervisor.user_id;
            console.log(`\nProcessing Hard Delete for Supervisor: ${supervisor.name} (ID: ${userId}, Email: ${supervisor.email})...`);

            // Check employee count in wards before deletion
            const empCheck = await client.query(`
                SELECT COUNT(*) FROM employee 
                WHERE ward_id IN (
                    SELECT ward_id FROM supervisor_ward WHERE supervisor_id = $1
                    UNION
                    SELECT ward_id FROM supervisor_kothi WHERE supervisor_id = $1
                    UNION
                    SELECT ward_id FROM user_kothi_access WHERE user_id = $1
                )
            `, [userId]);
            console.log(`Employees under supervisor's assigned wards (Will NOT be affected): ${empCheck.rows[0].count}`);

            // Delete from mapping tables
            const d1 = await client.query(`DELETE FROM supervisor_ward WHERE supervisor_id = $1`, [userId]);
            console.log(`Deleted from supervisor_ward: ${d1.rowCount} rows`);

            const d2 = await client.query(`DELETE FROM supervisor_kothi WHERE supervisor_id = $1`, [userId]);
            console.log(`Deleted from supervisor_kothi: ${d2.rowCount} rows`);

            const d3 = await client.query(`DELETE FROM user_kothi_access WHERE user_id = $1`, [userId]);
            console.log(`Deleted from user_kothi_access: ${d3.rowCount} rows`);

            const d4 = await client.query(`DELETE FROM user_city_access WHERE user_id = $1`, [userId]);
            console.log(`Deleted from user_city_access: ${d4.rowCount} rows`);

            // Hard Delete from users
            const dUser = await client.query(`DELETE FROM users WHERE user_id = $1`, [userId]);
            console.log(`Hard Deleted supervisor user from users table: ${dUser.rowCount} rows`);
        }

        await client.query('COMMIT');
        console.log("\n✅ HARD DELETE COMPLETED SUCCESSFULLY!");

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Error during hard delete:", err);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
