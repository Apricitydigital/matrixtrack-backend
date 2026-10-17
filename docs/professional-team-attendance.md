# Team Attendance in the employee app

Workspace → Team Attendance is read-only and available to Project Head / Site Head, Project Manager, HO Coordinator and Head of Department through the existing designation assignments. No new permission or account is required. Every API request checks the current designation and explicitly assigned sites. A site assignment alone does not grant access.

Filters: assigned site (or all assigned sites), month/year, one date (or the entire month), and employee name/code. Previous/next month navigation supports historical months; future months are blocked. Responses contain 50 employee/day records per page with summary counts for all matching records. Current/past days appear before upcoming days.

Each row shows employee, code, site, date, actual or attempted punch-in, punch-out, completed hours, and attendance status. Pending and rejected attempts stay distinct from Present. Accepted completed sessions under four hours show Half-day, matching the employee monthly report. Approved leave, weekly off and scoped holidays are shown when there is no accepted punch. Future dates are Upcoming. Inactive employees with punches in the selected month remain visible.

Site access follows each employee's current site assignment, matching the existing team tools. This is not a historical site-transfer ledger. Phone/email identity merging is not used, preventing attendance from accounts in unassigned sites from entering the report. Days without punches follow the existing report's missing-attendance rules; this module does not add employment-period accounting.

API: `GET /api/professional/team-attendance/sites`; `GET /api/professional/team-attendance?month=YYYY-MM&site=ID&date=YYYY-MM-DD&search=TEXT&page=1`. All filters except month are optional; month defaults to the current IST month. No write endpoint is exposed.

Verification: `node tests/professionalTeamAttendance.integration.js` uses isolated PGlite and never connects to live data. It covers all allowed roles, ordinary-user denial, site isolation, duplicate site assignments, invalid filters, inactive historical records, day/name/code filtering, pagination, and attendance statuses.
