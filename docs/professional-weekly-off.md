# Professional designations and weekly offs

The Professional department has three additional responsibilities: **Project Head / Site Head**, **HO Coordinator**, and **Country Head**. Multiple responsibilities can be assigned to one professional independently of the existing primary `Professional` designation.

## Admin setup

In the admin web app, open **Professional Designations** in the sidebar (`/professional-designations`). Search by professional name, employee ID or city; filter by designation and city. Select a professional, choose multiple designations, and select kothis across cities/zones. Site search, selected-only view and bulk selection apply to visible results. Filters do not clear selected sites in other cities. Settings also links to this page.

Delegate access using the `professional-weekly-off` module (`view` or `write`), exposed in Settings and as `professional_weekly_off` in Admin Management. The dedicated page requires this module's permission independently of Settings access. Backend assignment operations require admin authentication, module permission, and city scope. A partial-city admin cannot remove an existing site assignment outside that scope.

## Professional app

- HO Coordinator: **Workspace > Week Off**, employee search/site filter, manual weekly-off updates, template download and `.xlsx` upload.
- Country Head: **Workspace > Week Off** and dashboard overview, daily counts, employee schedules, coordinator update counts and history.
- All roles, including Country Head and dual-role professionals, can only view explicitly assigned sites and their active employees, dashboard, history and exports. No site assignments means no visible sites or employees. Country Head is view-only; HO Coordinator can change schedules within the same assigned sites.
- The feature manages active **professional employees** in their assigned kothis. Ordinary employee attendance remains a separate existing workflow.

Template columns are `Employee Name`, `Employee ID`, `Assigned Site`, `Weekly-Off Day`. Employee ID is the employee code, falling back to the permanent professional UUID. Names are display values; matching uses the ID. Weekday values accept full names or 0–6 (Sunday=0). The coordinator workflow assigns one weekly day per employee. Existing legacy schedules with multiple days remain readable until changed.

Uploads must be one `.xlsx` file, at most 5 MB and 10,000 rows. Each populated row must have a valid day. Unknown/ambiguous employees, duplicates, incorrect sites or unauthorized employees reject the entire upload. The response lists row errors and makes no changes.

## Dates, history and attendance

Changes apply from today in IST or a selected future date, repeating until another effective change. Retroactive dates are rejected. Future-dated changes become active on their effective date. Past dated history remains available, and legacy schedules receive a baseline so older reports retain their previous configuration.

Daily and monthly attendance, the attendance timeline/CSV download, range summaries and payable-day calculations use the schedule effective on each date. Worked weekly offs preserve punch records and show the weekly-off flag. Attendance, approved leave, scoped holidays and weekly offs overlapping on one date count as **one paid day**. Coordinator identity, old/new days, effective date and change time are recorded. Existing admin leave-allocation weekly-off edits also produce history.

## Deployment and verification

Backend startup runs `db/migrations/20261009_professional_weekly_off.sql` in a transaction. It creates designation/site mappings, dated history, SQL helpers and RBAC permissions. It is safe to run again. Deploy the backend migration before the updated admin web/mobile clients. This change does not itself publish a new mobile build.

Run unit/regression tests:

```powershell
node --test tests/*.test.js
```

Run SQL, assignment, Excel, attendance and payroll verification against the configured database:

```powershell
node scripts/verify-professional-weekly-off.js
```

The verifier creates an isolated schema inside a transaction and rolls everything back; it does not edit application records. Alternatively install `@electric-sql/pglite` as an optional local test dependency and run `node scripts/verify-professional-weekly-off.js --local-pg`. `WEEKLY_OFF_PGLITE_PATH` may point to an external workspace installation of that package.
