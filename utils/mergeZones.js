/**
 * Merge one or more source zones into a target zone without downtime.
 *
 * Usage:
 *   node utils/mergeZones.js --target 5 --source 6,7 --rename "Zone - 2 (Kothrud)" --dry-run
 *
 * Flags:
 *   --target / -t   Target zone_id that survives
 *   --source / -s   Comma-separated list of zone_ids to merge into target
 *   --rename / -r   Optional new name for the target zone after merge
 *   --force         Skip same-city check (not recommended)
 *   --dry-run       Do not write, only print the plan and checks
 *
 * The script:
 *   1) Validates the supplied IDs and that all zones exist (and are in the same city).
 *   2) Detects ward / sector name collisions that would violate unique constraints.
 *   3) Shows row counts per table that will be moved.
 *   4) Runs a single transaction to:
 *        - Drop duplicate user_zone_access rows that would violate PK
 *        - Re-point foreign keys (wards, sectors, geofencing, geofencing_requests, user_zone_access)
 *        - Delete source zones
 *        - Optionally rename the target
 *
 * Keep the app online: the updates are short, run inside one transaction.
 */

const pool = require("../config/db");

const args = process.argv.slice(2);

function parseArgs() {
  const opts = { source: [], dryRun: false, force: false, autoResolve: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--target":
      case "-t":
        opts.target = Number(args[++i]);
        break;
      case "--source":
      case "-s":
        opts.source = String(args[++i])
          .split(",")
          .map((x) => Number(x.trim()))
          .filter(Number.isFinite);
        break;
      case "--rename":
      case "-r":
        opts.rename = args[++i];
        break;
      case "--dry-run":
      case "--dry":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--auto-resolve":
        opts.autoResolve = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  if (!opts.target || !opts.source.length) {
    console.error("Usage: --target <zone_id> --source <id1,id2,...> [--rename <name>] [--dry-run] [--force]");
    process.exit(1);
  }
  if (opts.source.includes(opts.target)) {
    console.error("Source list must not include the target zone.");
    process.exit(1);
  }
  return opts;
}

async function fetchZones(client, ids) {
  const { rows } = await client.query(
    "SELECT zone_id, zone_name, city_id FROM zones WHERE zone_id = ANY($1::int[])",
    [ids]
  );
  return rows;
}

async function checkNameCollisions(client, targetId, sourceIds) {
  // Ward name collisions (unique_ward_per_zone)
  const wardSql = `
    SELECT DISTINCT w.ward_name
    FROM wards w
    JOIN wards wt ON wt.zone_id = $1 AND wt.ward_name = w.ward_name
    WHERE w.zone_id = ANY($2::int[])
  `;
  const wardConflicts = (await client.query(wardSql, [targetId, sourceIds])).rows.map((r) => r.ward_name);

  // Sector name collisions (unique_sector_per_zone)
  const sectorSql = `
    SELECT DISTINCT s.sector_name
    FROM sectors s
    JOIN sectors st ON st.zone_id = $1 AND st.sector_name = s.sector_name
    WHERE s.zone_id = ANY($2::int[])
  `;
  const sectorConflicts = (await client.query(sectorSql, [targetId, sourceIds])).rows.map((r) => r.sector_name);

  return { wardConflicts, sectorConflicts };
}

async function autoResolveConflicts(client, sourceIds, collisions) {
  const { wardConflicts, sectorConflicts } = collisions;

  if (wardConflicts.length) {
    await client.query(
      `UPDATE wards
       SET ward_name = ward_name || ' (merged from zone ' || zone_id || ')'
       WHERE zone_id = ANY($1::int[]) AND ward_name = ANY($2::text[])`,
      [sourceIds, wardConflicts]
    );
  }

  if (sectorConflicts.length) {
    await client.query(
      `UPDATE sectors
       SET sector_name = sector_name || ' (merged from zone ' || zone_id || ')'
       WHERE zone_id = ANY($1::int[]) AND sector_name = ANY($2::text[])`,
      [sourceIds, sectorConflicts]
    );
  }
}

async function tableCounts(client, ids) {
  const tables = ["wards", "sectors", "geofencing", "geofencing_requests", "user_zone_access"];
  const summary = {};
  for (const t of tables) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${t} WHERE zone_id = ANY($1::int[])`, [ids]);
    summary[t] = rows[0].count;
  }
  return summary;
}

async function mergeZones(opts) {
  const client = await pool.connect();

  try {
    const zones = await fetchZones(client, [opts.target, ...opts.source]);
    if (zones.length !== opts.source.length + 1) {
      const found = zones.map((z) => z.zone_id);
      const missing = [opts.target, ...opts.source].filter((id) => !found.includes(id));
      throw new Error(`Zone(s) not found: ${missing.join(", ")}`);
    }

    const target = zones.find((z) => z.zone_id === opts.target);
    const sources = zones.filter((z) => opts.source.includes(z.zone_id));

    const sourceCitySet = new Set(sources.map((z) => z.city_id));
    if (!opts.force && (sourceCitySet.size > 1 || !sourceCitySet.has(target.city_id))) {
      throw new Error("Source zones must be in the same city as the target (use --force to override).");
    }

    let collisions = await checkNameCollisions(client, opts.target, opts.source);
    const hasConflicts = collisions.wardConflicts.length || collisions.sectorConflicts.length;
    if (hasConflicts && !opts.autoResolve) {
      const messages = [];
      if (collisions.wardConflicts.length) messages.push(`Wards: ${collisions.wardConflicts.join(", ")}`);
      if (collisions.sectorConflicts.length) messages.push(`Sectors: ${collisions.sectorConflicts.join(", ")}`);
      const err = new Error("Name conflicts detected. Resolve/rename before merging.");
      err.details = messages;
      throw err;
    }

    const counts = await tableCounts(client, opts.source);

    const plan = {
      target: { id: target.zone_id, name: target.zone_name, city_id: target.city_id },
      sources: sources.map((s) => ({ id: s.zone_id, name: s.zone_name, city_id: s.city_id })),
      counts,
      rename: opts.rename || null,
    };

    if (opts.dryRun) {
      return { executed: false, plan };
    }

    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout TO 15000");

    await client.query(
      `DELETE FROM user_zone_access uza
       WHERE uza.zone_id = ANY($1::int[])
         AND EXISTS (
           SELECT 1 FROM user_zone_access u2
           WHERE u2.user_id = uza.user_id AND u2.zone_id = $2
         )`,
      [opts.source, opts.target]
    );

    if (hasConflicts && opts.autoResolve) {
      await autoResolveConflicts(client, opts.source, collisions);
      collisions = await checkNameCollisions(client, opts.target, opts.source);
      if (collisions.wardConflicts.length || collisions.sectorConflicts.length) {
        const err = new Error("Auto-resolve failed; conflicts remain.");
        err.details = [];
        if (collisions.wardConflicts.length) err.details.push(`Wards: ${collisions.wardConflicts.join(", ")}`);
        if (collisions.sectorConflicts.length) err.details.push(`Sectors: ${collisions.sectorConflicts.join(", ")}`);
        throw err;
      }
    }

    await client.query("UPDATE wards SET zone_id = $2 WHERE zone_id = ANY($1::int[])", [opts.source, opts.target]);
    await client.query("UPDATE sectors SET zone_id = $2 WHERE zone_id = ANY($1::int[])", [opts.source, opts.target]);
    await client.query("UPDATE geofencing SET zone_id = $2 WHERE zone_id = ANY($1::int[])", [opts.source, opts.target]);
    await client.query("UPDATE geofencing_requests SET zone_id = $2 WHERE zone_id = ANY($1::int[])", [
      opts.source,
      opts.target,
    ]);
    await client.query("UPDATE user_zone_access SET zone_id = $2 WHERE zone_id = ANY($1::int[])", [
      opts.source,
      opts.target,
    ]);

    await client.query("DELETE FROM zones WHERE zone_id = ANY($1::int[])", [opts.source]);

    if (opts.rename) {
      await client.query("UPDATE zones SET zone_name = $1 WHERE zone_id = $2", [opts.rename, opts.target]);
    }

    await client.query("COMMIT");
    return { executed: true, plan };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const opts = parseArgs();
  try {
    const result = await mergeZones(opts);
    console.log("Ready to merge zones:");
    console.table([
      { role: "target", id: result.plan.target.id, name: result.plan.target.name, city_id: result.plan.target.city_id },
      ...result.plan.sources.map((s) => ({ role: "source", id: s.id, name: s.name, city_id: s.city_id })),
    ]);
    console.log("Rows that will move:", result.plan.counts);
    if (result.plan.rename) {
      console.log(`Target will be renamed to: ${result.plan.rename}`);
    }
    if (result.executed) {
      console.log("✅ Merge completed successfully.");
    } else {
      console.log("Dry run mode: no changes were made.");
    }
  } catch (err) {
    console.error("Merge failed:", err.message);
    if (err.details) console.error(err.details.join(" | "));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { mergeZones };
