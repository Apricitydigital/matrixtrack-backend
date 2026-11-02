# City → Zone → Ward rollout

The physical `wards.ward_id` remains unchanged. The migration CLI automatically
combines the old Sector label and physical Ward label as `Sector + Ward` before
retiring the Sector link, in the same transaction. The former Kothi is now called
Ward. The intermediate Sector is retired from active master setup, registration,
employee forms, transfer and report filters. See [combined-name details and
production commands](combined-ward-names.md).

| Storage | Meaning after cutover |
| --- | --- |
| `wards.ward_id`, `wards.zone_id` | Existing physical Ward ID and direct Zone; unchanged |
| `wards.ward_name` | Automatically combined `Sector + Ward` name; exact approved map checked |
| `ward_name_retirement_backup` | Original/combined names for rerun, import aliases and rollback |
| `wards.sector_id` | NULL, enforced by `wards_retired_sector_null` |
| `employee.ward_id` | Existing physical Ward; unchanged and still required |
| Self Attendance `kothi_id` | Compatibility wire/storage alias for the physical Ward |
| Self Attendance `ward_id` | Retired parent snapshot; existing values preserved, nullable for new rows |
| Historical attendance location columns | Original snapshots; never guessed or backfilled |

The three deprecated parent fields made nullable are
`self_punch_requests.ward_id`, `self_attendance_employees.ward_id` and
`self_attendance_records.ward_id`. Their original NOT NULL metadata is saved in
`ward_sector_retirement_columns`. Physical Employee Master links are not relaxed.

## Compatibility and permissions

Old URLs/JSON keys remain accepted for installed clients. New public Ward lists
use `/public/wards?zone_id=...&hierarchy=city_zone_ward`. Old Kothi dropdowns
remain readable. Sector master write APIs return 410; physical Ward master writes
cannot attach a Sector. New registrations require an explicit physical Ward.

Legacy authorization interpreted both Sector and physical Ward numeric IDs.
Those namespaces overlap. Reading NULL active parents directly changes existing
supervisor visibility. `ward_legacy_sector_links` reads the frozen original map
in `ward_sector_retirement_backup` for those compatibility rules only.
Set `WARD_HIERARCHY=city_zone_ward` for the compatible backend after migration.
All active hierarchy APIs continue to read the physical `wards` table directly.
Do not remove the archive or compatibility view while those rules are in use.

The migration compares the visible employee/request set for every supervisor
before and after cutover, using the actual visibility SQL. A difference aborts
the transaction. It does not rewrite user/site access assignments.

## Rehearse and apply

Run from `attendease-backend`. Deployment environment variables override the local
`.env`; an explicit `--env-file=PATH` instead uses that file alone. Both the expected
host and database name are mandatory, and the connected database/primary status is
checked before BEGIN. Never copy a dev target into a production command.

```powershell
# Read-only preview, including databases whose Sector links are already NULL.
node scripts/retire-sector-memberships.js --expected-host=EXPECTED_HOST --expected-database=EXPECTED_DATABASE --preview-names

# Complete transaction, validation and automatic rollback.
node scripts/retire-sector-memberships.js --expected-host=EXPECTED_HOST --expected-database=EXPECTED_DATABASE

# Apply only while the matching compatible backend/web/app are ready to use.
node scripts/retire-sector-memberships.js --expected-host=EXPECTED_HOST --expected-database=EXPECTED_DATABASE --include-self-attendance-rename --apply --compatible-code-deployed --maintenance-confirmed --payroll-export-verified
```

For production, use a maintenance window and an independent database snapshot.
Prepare the compatible release first, run the rehearsal against the intended
production host, stop writers during cutover, apply, configure the hierarchy flag,
and start the compatible backend and clients before restoring traffic. Production
has not been migrated by the dev work.

The later production-safety audit found an enabled `awsdms_intercept_ddl` event
trigger on the dev clone. Its presence alone does not prove an active replication
task, but it is an explicit migration blocker until the DMS/CDC topology and DDL
handling are reviewed. The new guard stops before migration DDL; no trigger was
disabled or bypassed. Inspect the actual production catalog and replication setup
read-only when that connection is provided. AWS documents this trigger as part of
[PostgreSQL DDL capture for DMS](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html).
Do not assume an old clone's trigger or replication state matches production.

Preflight rejects missing/conflicting direct Zones, orphan employee/site links,
Sector-only legacy access mappings, unknown dependent views, enabled Ward write
triggers, database DDL event triggers, incomplete preservation/scope tables and
Sector-scoped holidays without a physical Ward. Resolve those
explicitly; do not bypass the guards or turn a scoped holiday into a global one.

The transaction saves the original Ward parent map, original/combined labels and
dashboard view definition, updates the exact planned Ward names, clears current
parent memberships, updates dashboard Ward aliases to physical Ward IDs/names,
and checks protected data after all schema/view changes. The Ward fingerprint
permits only the exact ID/name pairs in the validated name plan to differ; every
other Ward field and every employee/attendance row remains protected. It uses
row-content checksums for Employee Master, Self Attendance history/profiles and
the other protected tables. Regular punches now receive a full-content check:
every row is hashed as JSONB in PostgreSQL, sorted MD5 row hashes are streamed in
bounded batches into SHA-256, and count/ID sum are retained. A changed employee,
date, status, photo, GPS field or punch time therefore changes the fingerprint.
The migration contains no attendance writes. Protected tables are locked against
writers until the transaction ends; stop all writers before rehearsal/apply.
The original dev cutover artifact used count/ID sum for regular punches; it remains
immutable historical evidence and is not retroactively claimed as a full-row check.

Rerunning apply is idempotent: original backups are preserved, a combined prefix
is not appended twice, and membership/name updates change zero rows after a
successful cutover. Parentless names and names already equal to/prefixed with the
Sector label remain as stored. Reports go to the workspace
`outputs` directory. Keep the first applied report with the database snapshot.

## Rollback

```powershell
# Rehearse restoring original parents and dashboard view; automatically roll back.
node scripts/retire-sector-memberships.js --expected-host=EXPECTED_HOST --expected-database=EXPECTED_DATABASE --rollback

# Restore original parents after reviewing the rehearsal.
node scripts/retire-sector-memberships.js --expected-host=EXPECTED_HOST --expected-database=EXPECTED_DATABASE --rollback --apply --compatible-code-deployed --maintenance-confirmed --payroll-export-verified
```

Rollback restores original names as well as parent links, and refuses later HR
edits/new name conflicts rather than overwriting them. It refuses missing/conflicting
Ward/Zone/Sector mappings. It preserves
employee links, access data and punches, including valid new NULL parent snapshots.
The legacy parent columns remain nullable; rollback never invents Sector IDs to
restore NOT NULL. Review newly created locations/profiles before reverting to an
older application release. The compatibility backend can stay in use throughout.

## Verification

- `npm.cmd run test:self-attendance`: syntax/import checks and isolated backend tests.
- `tests/wardNameMigration.integration.js`: atomic name+Sector cutover, immutable
  name backups, exact employee/punch preservation, old/new spreadsheet names,
  already-detached parents, duplicates/length/index guards, HR-edit protection,
  rollback and reapply.
- `tests/wardMigrationCli.integration.js`: actual CLI read-only preview, rehearsal,
  apply, rollback and non-overwriting report paths, using isolated PostgreSQL.
- `tests/wardNameEdgeCases.integration.js`: Unicode 100/101-character boundaries,
  quoted names, unknown geography/parent-map conflicts, stale name/Zone/parent
  previews, untouched-Ward and journal corruption, empty directories, blank and
  case/transition collisions, backup-trigger refusal, CLI option errors, cleanup
  failures and both lost/confirmed commit outcomes. Journals are cross-checked
  before restoration.
- `tests/wardNameCapacity.integration.js`: guarded 255-character expansion,
  unchanged business/view rows, exact ACL/grant options, reader access, comments,
  collations and security settings; unknown dependencies/grants block changes.
- `tests/payrollCutover.integration.js`: 2,002 simulated regular employees and
  62,032 punches reconcile across expansion/name cutover/rollback; same-total input
  changes, one-shot legacy rename rollback, strict commit outcomes and payroll
  acknowledgement are checked. External HR salary formulas remain a separate gate.
- Frontend `npm.cmd test -- --watchAll=false --runInBand` and `npm.cmd run build`.
- `tests/sectorRetirement.integration.js`: original NOT NULL constraints, overlapping
  numeric IDs in different Zones, exact supervisor visibility, city/site scope
  intersection, direct dropdowns, old dropdown compatibility, HR import, location
  validation, transfer, a new punch with NULL parent, idempotency and rollback.
- `tests/productionAttendancePreservation.integration.js`: same-count/same-ID
  employee reassignment and punch/status corruption detection, final verification
  after schema changes, duplicate preservation, event-trigger and incomplete-schema
  rejection, and restoration of original rows/constraints after rollback.
- `tests/migrationTarget.test.js`: required host/database, deployment environment
  and explicit file selection, maintenance acknowledgement, actual DB identity and
  replica rejection. These are independent of any production connection.
- `tests/physicalWardReportFilter.integration.js`: actual Attendance/Leave filter
  builders execute against overlapping Sector/Ward IDs; flat-mode physical filters
  cannot substitute the old parent snapshot. Historical punches with no stored
  physical site still follow the employee report's current physical assignment.
- `tests/selfAttendanceIdentityPrevention.integration.js`: the actual registration
  handler saves a physical Ward with a NULL parent, while identity conflicts and
  simultaneous duplicate registrations remain protected.
- `tests/supervisorSelfPunchApproval.test.js`: the actual approval handler creates
  a NULL-parent profile and links Employee Master to the exact physical Ward;
  provider calls are isolated stubs.
- `tests/selfAttendanceRecordsBlock.integration.js`: actual punch-in, duplicate
  rejection and punch-out with a NULL Sector; the physical Ward snapshot is retained.
- Frontend `WardRegistrationMobile.test.js`: the actual app form uses three
  selectors, submits the selected physical Ward, ignores stale location responses
  and refuses an older server without the `city_zone_ward` response marker.
- `tests/selfAttendanceGeofenceWorkflow.integration.js`: request, duplicate guards,
  city authorization, approval/rejection, radius changes, distance enforcement and
  deletion with a NULL-parent profile; provider calls remain isolated stubs.
- `tests/wardReportMapping.integration.js`: actual Supervisor Audit and Short
  Attendance SQL returns physical Ward names/IDs with NULL Sector parents; Audit
  requires its view permission and City/Ward scope, and Short Report cannot expand
  assigned Ward access via its physical-ID filter.
- Workspace `scratch/audit-self-attendance-live.cjs --flat-rehearsal`: actual dev
  profile/monthly/block, supervisor/Register/team and report handlers against the
  temporarily migrated schema; all changes rolled back and no provider calls.
- After apply, run the same audit without `--flat-rehearsal` for read-only checks.

Phone camera/GPS, cloud face recognition, uploads, SMS and push delivery still
need device/provider smoke testing. Automated/live read checks do not claim those
external operations were performed.

The current cross-repository results and remaining native/device acceptance are
recorded in workspace `outputs/full-app-web-backend-readiness.md`. A JavaScript
export is not an installable APK. Release the new three-selector form only after
the production backend and nullable-column migration are compatible.

The frontend's active Master, audit and report flows use City -> Zone -> Ward.
Supervisor Audit rows are grouped by supervisor plus physical Ward, and report
CSV/Excel/PDF output has one physical Ward column. The workspace report
`outputs/frontend-ward-ui-verification.md` records the latest copy/mapping audit,
component checks, backend checks and compiled-source verification. Historical
Sector fields in audit payloads remain explicitly labelled Legacy Sector; wire
aliases such as `kothi_id` remain compatible and are not active geography controls.

The local dev clone uses ignored `.env.development.local` files in web/mobile to
target the local backend. The mobile configuration resolves localhost to the Expo
LAN host, or the Android emulator alias. Restart the backend, frontend dev server
and Expo bundler after changing environment files. Production build defaults are
not overridden by these development-only files.
