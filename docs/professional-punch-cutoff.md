# Professional punch-in cutoff

Workspace → Punch-in Management provides Set Punch-in Time and Late Requests.
Project Head / Site Head is the existing Project Manager designation. Project Manager is also recognized if assigned. HO Coordinators and PMs can set cutoffs for employees in their explicitly assigned sites. Head of Departments have read access within their assigned sites. Use the existing Professional Designations admin screen to assign responsibilities and sites.

Times are in IST. Every assigned time includes 15 minutes grace for new punch-ins (including times set by PM, HO or admin bulk tools). For 09:30, arrival up to and including 09:45:00 is accepted normally; after 09:45:00 the PM → HO approval process applies. The stored assigned time is unchanged. The deadline uses a full IST timestamp so grace near midnight does not wrap to an earlier time on the same day. Employees with no configured cutoff retain normal attendance. The server captures arrival time before face verification; only verified late attempts become requests. Existing pending/rejected records and cutoff snapshots are preserved. Employees cannot submit another attempt that day while pending or after rejection.

Superadmin → Admin Management has a global **Professional late punch-in restriction** switch. It defaults OFF. Only a current, non-deleted Superadmin account can read/change it; changes are audited in `professional_punch_setting_history`. When OFF, new verified punches bypass the cutoff and are marked normally. Existing pending requests retain their approval process and rejected records stay rejected. Enabling again applies stored cutoff times to new punches. Geofence, face verification and duplicate-punch checks still apply in both modes.

Employees can see PM and HO approval progress on Home and monthly attendance records, including reviewer name, review time and note. Home refreshes today's status every 30 seconds while focused. PM rejection shows the HO stage as not required; PM approval shows HO pending; final HO approval shows both approved.

Late attempts are stored with `punch_in=NULL`, the original time in `attempted_punch_in`, and `pending_pm` status. PM Allow advances to `pending_ho`. HO Allow sets `punch_in` to the original attempt and changes status to `accepted`. Either rejection is final and displays **Punch in but not accepted**. Pending attempts display **In Consideration**. They do not count as present or worked hours. Punch-out is available after final approval. A reviewer cannot approve their own request, and the two reviewers must be different people.

Notifications and the Workspace bell target only the pending stage's assigned PM/HO reviewers. Project Head approval of a late punch-in requires a non-empty reason (up to 1000 characters), enforced in the API and app. The reason, reviewer name and review time accompany the request for the HO Coordinator and view-only Head of Department (HOD). HO remains the final approver. Other review notes are optional. History and requests currently show the latest 500 entries.

Employee monthly attendance includes a separate Late Punch-in count and pink calendar/record marker whenever `attempted_punch_in` exists. This marker remains after acceptance or rejection; the underlying Present/Half-day/Rejected status and payable calculations are unchanged. The professional Country Head designation is renamed to Head of Department using `20261016_professional_hod.sql`; existing responsibility/site assignments are preserved, and HOD stays view-only.

Migration: `db/migrations/20261014_professional_punch_cutoff.sql` requires the existing weekly-off assignment schema. The backend ensures this additive migration on first use, inside a transaction with an advisory lock. Existing accepted punches remain accepted. No employee cutoff is seeded automatically.

Local verification: `node tests/professionalPunchCutoff.integration.js` uses the workspace's PGlite installation and makes no live database changes.

## Admin bulk import and downloads

Sidebar → **Bulk Punch-in Times** (`/professional-punch-times`) manages existing professional employee cutoff times using employee codes. This does not create employee accounts. Superadmin assigns **Bulk Punch-in Times** permissions in Admin Management: No Access blocks the page and API, View Only allows scoped downloads/history, and View & Edit also allows preview/import and direct employee cutoff edits. It uses the existing configured MT Superadmin identity, not a new email/account. Assigned-city limits apply to custom admins and are enforced against current database permissions.

Download a `.xlsx` template for all assigned cities, one city, or one site. Separate city/site sheets are also available in a single workbook. Every employee sheet can be imported; the Instructions sheet is ignored. Headers are Employee Code, Employee Name, City ID, City Name, Site ID, Site Name, Punch-in Cutoff (IST). Codes remain text, preserving leading zeros. Use 24-hour HH:mm; Excel time values and AM/PM text are supported. Formula cells are rejected. Context names are optional; IDs disambiguate repeated employee codes across cities/sites.

Every download also contains **City & Site Reference**, with unique City ID/City Name, Project Name and Site ID/Site Name mappings from the selected download scope. This supporting sheet is ignored during import, so HR can forward the complete workbook without removing it.

Validate & preview displays old/new times. Apply revalidates the file against current assignments and saves the entire batch in one transaction. Unknown, inactive or ambiguous codes, duplicates, invalid times, mismatched context, and out-of-scope rows reject the entire upload with sheet/row errors. Maximum upload is 5 MB / 10,000 rows. Existing pending/rejected attendance and their cutoff snapshots are preserved.

Migration `20261014_professional_punch_cutoff_bulk.sql` adds admin actor fields and seeds the View/Write permission catalog without granting access to custom admins. Apply the base cutoff migration first. Startup and the schema helper apply both cutoff migrations in that order. Admin imports and PM/HO changes share one audit trail and are visible to their respective city/site scopes.

In Employee schedules, use **Set time** or **Edit time**, choose a time in IST, and **Save** (or **Cancel** to discard). Direct saves use `PUT /admin/professional-punch-times/employees/:employee` with `{cutoff_time:"HH:mm"}` and the selected city/site query filters. The API checks current Write permission, active employee and city/site scope, locks the employee, and saves cutoff plus admin audit together. The list and history refresh after saving; existing attendance snapshots are preserved.
