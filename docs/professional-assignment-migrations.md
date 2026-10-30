# Professional assignment and attendance references

Deploy with `node scripts/migrate-professional-assignment.js --apply` (already
included in the backend deploy workflow). Without `--apply` it only lists the
migrations. Both repairs run in one transaction; a lock wait longer than three
seconds aborts the repair rather than holding up punches.

When the October 29 profile repair is already installed, apply only the
attendance repair with
`node scripts/migrate-professional-assignment.js --attendance-only --apply`.
This changes only the attendance ward constraint and its column comment.

Current professional assignments use `ward_id = sectors.sector_id` and
`kothi_id = wards.ward_id`. The October 29 migration corrects request/profile
foreign keys and preserves legacy assignments with `NOT VALID` constraints.

The October 30 migration removes the obsolete attendance `ward_id` foreign key.
This column is an assignment snapshot, and live legacy profiles still supply
IDs from `wards`, while transferred/current profiles supply IDs from `sectors`.
The ID ranges overlap. Replacing this FK with a `sectors` FK would reject new
punches from legacy profiles. Neither historical punches nor legacy assignments
are converted or inferred. Professional, city and zone constraints remain.

New assignments are checked against the city/zone/sector/site hierarchy by
`transferProfessional` and the profile/request foreign keys. Both professional
punch writers copy geography from the employee profile rather than trusting
client-supplied ward IDs. Attendance snapshots preserve that value across later
transfers.

Regression check: `node --test tests/professionalTransfer.test.js` reproduces the
old attendance foreign-key failure after a successful transfer, then verifies
new-posting punches, legacy punches, punch-out, repeat deployment, another
transfer and unchanged history.
