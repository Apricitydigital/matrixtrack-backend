/**
 * Migration: add is_active column to public.cities
 * Run once: node add-city-is-active.js
 */
const pool = require("./config/db");

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Add is_active column (default true so all existing cities stay active)
        await client.query(`
      ALTER TABLE public.cities
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true
    `);

        // Add an index for fast filtering
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cities_is_active
        ON public.cities (is_active)
    `);

        await client.query("COMMIT");
        console.log("✅ Migration complete: cities.is_active column added.");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Migration failed:", err.message);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrate();
