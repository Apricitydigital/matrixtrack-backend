# Automatic combined Ward names

The Ward retirement CLI now automatically writes **old Sector name + physical
Ward name** into `wards.ward_name`. For example `Human Matrix` + `Solaris` becomes
`Human Matrix + Solaris`. This is a label change; it does not merge or renumber
physical Wards. `wards.ward_id`, `employee.ward_id`, Self Attendance `kothi_id`,
employee identities, attendance rows and stored historical location snapshots
are preserved. No frontend name parsing is required: active views already read
the physical Ward master name.

## Rules and guards

- Prefix comes from the actual `sectors.sector_name`, not the Zone label. If
  retirement already happened, use the frozen parent ID from
  `ward_sector_retirement_backup`, only in its original Zone.
- If a Ward has no parent, keep its current name. Equal/already-prefixed labels
  are kept without duplication; cosmetic spacing around hyphens/plus signs does
  not add a repeated prefix. Original spelling is retained for unchanged labels.
- Check proposed final names, Unicode character lengths, actual Ward/global
  uniqueness indexes and known dashboard-view limits. Do not truncate. Duplicate
  or transition-conflicting names, missing parents, changed Zones and unknown
  expression indexes block the migration for review.
- `ward_name_retirement_backup` stores original/combined labels and parent
  context. Reruns never overwrite these originals or double-prefix a name. Later
  HR name edits block overwrite/reversal. New Ward conflicts also block rollback.
  Saved name and parent journals must agree; missing/conflicting parent backup
  rows block restoration rather than silently leaving a Ward detached.
- Names and Sector retirement use one transaction. The exact intended ID/name
  map is included in the final row-content verification. Any other employee,
  attendance, access or Ward change fails and rolls back.
- HR bulk import accepts current names/IDs and the scoped original-name alias.
  If an alias is ambiguous, the upload fails instead of choosing an employee site.
  Name aliases remain readable in the reverse direction after rollback too.
- Database DDL/event-trigger guards still apply. `--preview-names` is purely
  read-only and can be used to inspect names without bypassing those guards.
- Unknown, duplicated or malformed CLI options are rejected before connecting.
  `--help` shows usage without reading DB configuration or connecting. Connection
  cleanup errors preserve the original failure or explicitly state that an apply
  already committed. Lost commit responses remain uncertain until DB verification;
  a server-confirmed rollback is never reported as an applied migration.

## Current dev preview finding

The live dev read-only preview found a proposed 104-character name while the
Ward column and dashboard name aliases currently permit 100. The CLI now plans
and performs a guarded expansion to 255 inside the same cutover transaction when
needed. `capacityPlan.valid` reports whether its dependencies/permissions are
supported; `validAfterPlannedCapacity` distinguishes repairable length issues
from invalid names. No real DB type/name was changed during implementation.

Only the two known read-only Ward/dashboard views may be rebuilt. Original row
contents, column order/types (except the intended wider names), ownership, exact
grants/grant-options, comments, collations and security options are checked and
preserved. Unknown dependents, writable views, column grants, security labels or
grant provenance require review. `DROP ... RESTRICT` is used, never CASCADE.
Table/column/employee IDs stay intact; rebuilt views receive new view OIDs.
The original schema/view metadata is saved in `ward_name_capacity_backup` and
the wider capacity is deliberately retained on name/parent rollback. This follows
[PostgreSQL's view type rules](https://www.postgresql.org/docs/current/sql-createview.html).
The actual production schema/data may differ and must get its own preview.

In the actual dev hierarchy, `Solaris office` is both the saved Sector and the
physical Ward label, so it stays `Solaris office`. `Human Matrix Securite` is the
Zone there; this feature does not silently substitute a Zone prefix.

## Production procedure

Prepare a separate secure `.env.production` file, or use the deployment environment.
Replace `PROD_HOST` and `PROD_DB` below with the exact intended target. Do not copy
dev rows/dumps into production. These commands do not run automatically on server
startup; no production operation was performed during implementation.

1. Inspect the production target read-only and take/validate its backup. Run this
   name preview first, before any schema cutover:

   ```powershell
   node scripts/retire-sector-memberships.js --env-file=.env.production --expected-host=PROD_HOST --expected-database=PROD_DB --preview-names
   ```

   Review names, `capacityPlan`, `validAfterPlannedCapacity`,
   `databasePreflightReady`, `ddlEventTriggers` and `requiredNameCapacity`.
   A saved preview/non-zero exit is not an applied update. Known supported length
   expansion is automatic; duplicates/unsupported dependencies and DMS blockers
   still require review. `readyForApply` also requires the operator's HR-export
   acknowledgement and is not certification of an external salary workbook.

2. On a fresh production-sized staging copy, rehearse the one-shot cutover. The
   optional naming phase, required capacity expansion and Ward/name changes all
   share one transaction. Default mode verifies and rolls back. It locks writers, so
   never treat a rehearsal as an ordinary read-only query on a busy live server:

   ```powershell
   node scripts/retire-sector-memberships.js --env-file=.env.staging --expected-host=STAGING_HOST --expected-database=STAGING_DB --include-self-attendance-rename
   ```

3. Verify the actual current HR export and salary-sheet contract BEFORE applying.
   Ward/site-name matching is currently uncertain, so employee counts alone cannot
   prove salary-sheet compatibility. Compare employee codes, columns/order,
   present/half-day/leave/payable totals and name-based lookup formulas using an
   anonymized real workbook/template. Neither simulated fixtures nor the following
   flag perform that external verification.

   During the maintenance window stop all writers/jobs, validate the backup/restore
   path and prepare the matching release. Only after the real HR comparison passes
   use the explicit acknowledgement in this one-shot command:

   ```powershell
   node scripts/retire-sector-memberships.js --env-file=.env.production --expected-host=PROD_HOST --expected-database=PROD_DB --include-self-attendance-rename --apply --compatible-code-deployed --maintenance-confirmed --payroll-export-verified
   ```

   All phases commit once; a later failure also rolls back the table rename and
   capacity expansion. Employee/month attendance counts, open punches, raw elapsed
   time and row digests must match; mismatches abort. This reconciles attendance
   inputs, not external salary amounts/formulas. No HR-by-HR location-name update
   is required. Retain the reports and DB backup. An existing
   report is never overwritten. A reported uncertain commit outcome requires DB
   verification before retrying.

4. Set `WARD_HIERARCHY=city_zone_ward` on the compatible backend. Start backend,
   then web/app, compare protected rows/open punches/scopes and refresh dropdowns.
   Restore traffic only after the coordinated release checks pass.

## Rollback

`--rollback --preview-names` previews the name reversal read-only. `--rollback`
alone rehearses restoring original names, parent links and the saved dashboard
view, then rolls back. Adding `--apply --compatible-code-deployed
--maintenance-confirmed --payroll-export-verified` applies that reviewed restoration.
It verifies payroll attendance inputs and preserves wider capacity. It does not reverse
the separate Professional table rename, and nullable historical snapshot fields
remain nullable. Do not restore an old full DB snapshot after accepting new punches
without a recovery plan that preserves them.

Source: `utils/wardNameMigration.js`, integrated through `utils/sectorRetirement.js`.
The library's optional `combineWardNames` flag preserves older name-preserving
callers; the supported production CLI enables it automatically.
