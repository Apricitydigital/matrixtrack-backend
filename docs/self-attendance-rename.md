# Self Attendance naming migration

The backend now uses **Self Attendance**. Existing IDs, attendance dates and times,
credentials, biometric data, employee codes, location IDs and stored photo keys
are preserved. Regular, register and supervisor attendance keep their existing
tables and behavior.

| Previously | Canonical name |
| --- | --- |
| `professional_employees` | `self_attendance_employees` |
| `professional_attendance` | `self_attendance_records` |
| `professional_id` | `self_attendance_id` |
| `professional_attendance_id` | `self_attendance_records_id` |
| `professional_*` supporting tables | `self_attendance_*` |
| `workforce_professional_login_aliases` | `workforce_self_attendance_login_aliases` |
| Professional department/designation label | Self Attendance (same IDs) |
| employee kind / attendance mode `professional` | `self_attendance` |
| `/api/professional/*` | `/api/self-attendance/*` |
| `/api/admin/professional-attendance/*` | `/api/admin/self-attendance-records/*` |
| `PROFESSIONAL_*` configuration | `SELF_ATTENDANCE_*` |

Attendance-specific objects use `self_attendance_records_*`; other supporting
objects use `self_attendance_*`. Camel-case JavaScript names follow the same
mapping (`selfAttendanceRecordsController`, `selfAttendanceAuth`, etc.).

## Production cutover

This is an explicit maintenance migration. It is never run from login, punch,
startup migrations or a normal deployment. The deployment workflow checks that
the naming cutover has already been completed before running the renamed schema
migrations. Do not run an old backend against the renamed schema.

For the full production release prefer the [one-shot payroll-protected Ward
cutover](combined-ward-names.md): it keeps naming, required capacity expansion and
Ward changes in one transaction. Acknowledging actual HR export verification is
required for apply; it does not substitute for reviewing the salary workbook.

1. Check out the reviewed backend revision and install its existing dependencies.
   Confirm the target configuration points at the intended host AND database name.
   Deployment environment overrides `.env`; explicit `--env-file=PATH` uses that
   file alone. The connected database name and primary status are verified. Obtain a
   restorable RDS snapshot/backup and record the old application revision.
2. Drain requests and stop every backend worker, scheduled job and standalone DB
   writer using that database. The migration takes exclusive locks on the
   affected tables and fails after five seconds if it cannot acquire a lock.
3. Rehearse the complete migration. This executes DDL/data validation inside a
   transaction and **always rolls it back**. The report contains row counts and
   fingerprints, never credentials or employee records:

   ```powershell
   npm run migrate:self-attendance:names -- --expected-host=YOUR_PRODUCTION_DB_HOST --expected-database=YOUR_PRODUCTION_DB_NAME --report=rename-rehearsal.json
   ```

4. Apply to the explicitly selected production host (replace the placeholder
   with that server's exact `DB_HOST`; do not copy the dev hostname):

   ```powershell
   npm run migrate:self-attendance:names -- --apply --maintenance-confirmed --payroll-export-verified --expected-host=YOUR_PRODUCTION_DB_HOST --expected-database=YOUR_PRODUCTION_DB_NAME --report=rename-applied.json
   node scripts/check-self-attendance-schema.js
   ```

   Other workforce/reference-schema upgrades are separate reviewed prerequisites
   if the actual production preflight requires them; do not run unrelated repair
   scripts as an unreviewed side effect of a Ward/name cutover.

5. Start the new backend revision. Check existing-account login, today's status,
   punch-in/out, a historical report, leave/week-off, regular attendance and
   register/supervisor attendance before reopening traffic. Offline regression
   checks run with `npm run test:self-attendance`.

The runner uses `ALTER ... RENAME` and checks table/FK identities and canonical
fingerprints of every affected row before commit. It also updates function
bodies, trigger arguments (including merge-alias hashes), constraints, indexes,
sequences, view columns, permission keys, discriminators and recovery-journal
metadata. A validation failure rolls the whole transaction back. A second apply
does not rewrite data; it verifies/installs any missing merge-reference triggers.
Mixed legacy/canonical schemas fail closed. A readiness rerun retains the original
cutover report and writes a separate `.readiness.json` report.

Enabled database DDL event triggers require explicit review before naming changes.
Unchanged regular attendance histories are separately locked and checked using
SHA-256 over sorted full-row MD5 fingerprints, even on an already-applied rerun.
The canonical row checks still cover renamed Self Attendance records and identity,
credentials, photo keys, permission metadata and recovery journals. Failed checks
must roll back; `--maintenance-confirmed` is required for an explicit apply.

For rollback **before reopening writes**, stop the new backend, restore the
pre-cutover database snapshot, then restart the matching old revision. Once new
punches have been accepted, use a reviewed forward fix; restoring an old snapshot
would discard those new punches. Never run old startup migrations against the
new schema: they can create empty legacy tables.

## Existing clients and integrations

The HTTP compatibility middleware accepts old paths, request field names and
filters. Old endpoints and shared endpoints without a naming opt-in retain their
old JSON field/discriminator contract. New paths return canonical fields.
On shared routes (for example `/api/attendance/combined`), new clients send
`X-Attendance-Naming: self-attendance`, or a `self_attendance` employee-type filter.
Workforce-review path kinds use `self_attendance`.

Previously issued signed JWTs carrying `professional_id` continue to authenticate
against the same account and merge aliases; newly issued tokens use
`self_attendance_id`. Conflicting claims are rejected. Old environment keys
remain fallbacks; explicitly supplied new keys take precedence. JWT secrets,
token lifetimes and face/geofence rules do not change.

Legacy spellings are intentionally confined to compatibility/migration code,
its alias catalog and migration fixtures. Existing people whose actual name is
"Professional", stored image paths, passwords, identifiers and historical free
text are not rewritten. The source rename does not migrate a separately deployed
MCP server or another application's direct SQL: update those SQL consumers to
the canonical table/column names during the same production maintenance window.
