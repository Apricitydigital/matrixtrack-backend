# Reviewed attendance identity recovery

The recovery is scoped to the three Manisha Dakwani UUIDs listed in
`config/professionalAttendanceIdentities.js`. Ownership was verified by comparing
decrypted Aadhaar values on 21 October 2026 without exporting the identifiers.
All three profiles have the same geography. The primary profile is the one
currently recording her attendance, not the most recently registered profile.

No attendance, employee, leave, credential, photo or approval rows are migrated
or deleted. No database migration is required. Deploy the backend changes and
restart the backend process to activate the correction. A frontend or mobile
app release is not required.

## Behaviour

- Reports combine only the explicitly listed profiles and display the current
  primary identity once. Original employee-code searches and profile links still
  work. Existing city/supervisor visibility checks remain in force.
- Mobile monthly attendance uses the reviewed UUID list for this identity.
  Unreviewed employees retain their existing matching behaviour; other flagged
  cases are not automatically merged.
- The four professional attendance routes resolve valid sessions to the same
  primary attendance account. The existing primary-profile row lock serializes
  punch-in attempts. Duplicate-punch and approved-leave checks include the
  reviewed historical IDs.
- Status and punch-out continue an already existing attendance row on its
  original source profile. Authentication, profile management, account status,
  geofencing configuration and leave administration are not globally remapped.
- Missing punch-outs are not filled and payroll rules are not changed.
- Links fail closed if a member is missing, geography differs, the primary is
  disabled, or attendance/leave dates overlap. Reports leave that group separate
  and reviewed attendance requests return an explicit review error instead of
  selecting an arbitrary record.

September acceptance result: **28 present, 1 half-day, 1 absent, 29 payable days**
in the app; **29 punch-in dates, 29 payable days** on the website. These measures
have different labels and must not all be called present days.

## Verification

```powershell
node --test tests/professionalAttendanceIdentity.test.js tests/professionalIdentity.test.js
$env:WEEKLY_OFF_PGLITE_PATH='D:/HumanMatrixSolutions/MatrixTrack/scratch/weekly-off-verification/node_modules/@electric-sql/pglite'
node scripts/verify-professional-weekly-off.js --local-pg
node tests/professionalPunchCutoff.integration.js
node tests/professionalPunchPerformance.test.js
node tests/professionalIdentityPrevention.integration.js
```

The weekly-off suite includes actual reporting/mobile controller regressions,
unrelated shared-email accounts, historical months, permissions, existing open
punches, conflicts and duplicate-punch guards in an isolated database.

For a live **read-only** comparison:

```powershell
node scripts/verify-professional-attendance-identity.js --live-read-only
```

This verifier disables schema initialization and external side effects and uses
an enforced read-only repeatable-read transaction. It checks report-input
checksums for all unlinked profiles/attendance/leaves across locations, compares
actual September range rows for Manisha's city, checks every old profile link,
the old employee-code search, and August/October history. It does not issue
production punch requests.

The existing unfiltered all-city September aggregate exceeded the verifier's
30-second limit even with the original calculation. That broader performance
issue is not claimed as fixed by this recovery. City-scoped report timing is
printed by the verifier.

## Rollback

Set `PROFESSIONAL_ATTENDANCE_IDENTITY_LINKS_ENABLED=false` in the backend runtime
environment and restart the backend, or revert this code change and restart.
This restores the previous reporting/routing behaviour; no data restoration is
needed because historical records remain untouched. Valid punches recorded on
the existing primary account after release remain ordinary attendance rows.

Do not add any other flagged employee merely because an email or mobile matches.
Verify ownership, select the primary, inspect scope and date conflicts, and add
case-specific regressions before extending the reviewed configuration.

## Prevention for future registrations and edits

Registration and approval check the existing account and pending/approved
request tables for normalized mobile, email and employee code conflicts. They
also compare decrypted Aadhaar across locations, including inactive accounts,
so changing all contact details or the location cannot create a second account
for the same identity. A rejected request without an account does not reserve
the identity. Approval excludes its own permanent request ID and rechecks old
pending requests before changing status or generating credentials.

Mobile comparison accepts equivalent Indian country-code formatting; employee
code comparison ignores case and whitespace; email comparison ignores case and
outer whitespace. These are comparison rules, not bulk rewrites of saved data.

Approved-list updates validate changed identifiers against accounts and
pending/approved requests and validate changed Aadhaar against existing owners.
Equivalent identifiers or Aadhaar assigned twice in one upload reject the whole
apply operation. Unchanged legacy values do not force cleanup of other profiles.
Valid corrections keep the existing permanent profile ID and attendance.

Registration, approval and applying bulk updates all hold the same transaction
advisory lock before checking identities. This serializes cooperating backend
writers and makes retries/simultaneous submissions recheck the latest committed
state. The isolated prevention integration test exercises concurrent controller
calls using a PostgreSQL fixture with transaction-lock scheduling.

Unreadable identity records produce a review error rather than bypassing Aadhaar
verification. The decryption index is request-local, never persisted or logged,
and Aadhaar conflict errors redact the full identifier. These checks do not
require a new unique constraint over existing legacy duplicates and do not
modify attendance. They protect these backend workflows after deployment;
direct SQL writers must not bypass the same validation and locking rules.
