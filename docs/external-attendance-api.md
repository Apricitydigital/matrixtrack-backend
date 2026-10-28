# Complete external attendance API

Base URL: `https://api.matrixtrack.in/api/v1/external`

Send the existing API key in the `x-api-key` header. No new key or JWT is needed.
Attendance endpoints require `attendance:read`; the employee and supervisor directories require `employees:read`.
The key's city, zone and site restrictions always apply, including to images and supervisor assignments.

## Requests

| Endpoint | Returns |
| --- | --- |
| `GET /attendance/full?date=2026-10-28` | Regular, supervisor-marked, Register and professional attendance in one paginated response |
| `GET /attendance/full?from=2026-10-01&to=2026-10-28` | Full data for a date range |
| `GET /attendance/daily?date=2026-10-28` | Regular employee attendance, including supervisor and Register sources |
| `GET /attendance/range?from=2026-10-01&to=2026-10-28` | Regular attendance for a date range, with the same full fields |
| `GET /attendance/employee/123?from=2026-10-01&to=2026-10-28` | A regular employee's attendance, including full evidence |
| `GET /professional/attendance/daily?date=2026-10-28` | Professional punches, approval status, coordinates and images |
| `GET /attendance/summary?date=2026-10-28` | Daily totals; Register present is included in `total_present` and counted separately |
| `GET /employees` | All registered Employee Master records in scope, including employees with no attendance; mode, face registration and assigned supervisors |
| `GET /employees/123` | One registered employee with the same directory fields |
| `GET /supervisors` | Legacy supervisors and professional Project Managers/Project Heads with their permitted assignments and photos |

Use `page=1&limit=200` to retrieve pages (default 50, maximum 200). Fetch all pages through `pagination.total_pages`.
Date ranges allow at most 31 inclusive days. Dates must be valid calendar dates.

Optional filters: `city_id`, `zone_id`, `sector_id`, `ward_id`. `ward_id` means the actual kothi/site ID, including for professionals; `sector_id` is the ward/sector group.
Query filters intersect with API-key restrictions. Asking for another city never broadens access.
Attendance filters: `emp_id` for regular employees, `professional_id` for professionals, and `source=all|punch|supervisor|register`.
The full endpoint additionally accepts `employee_type=all|regular|professional` (default `all`).
Use `employee_kind` together with `employee_id` as the employee identity: a regular ID and professional UUID are separate identities even when employee codes match.

```bash
curl --get 'https://api.matrixtrack.in/api/v1/external/attendance/full' \
  --header "x-api-key: $MATRIXTRACK_API_KEY" \
  --data-urlencode 'from=2026-10-01' \
  --data-urlencode 'to=2026-10-28' \
  --data-urlencode 'employee_type=all' \
  --data-urlencode 'page=1' \
  --data-urlencode 'limit=200'
```

Import [the Postman collection](MatrixTrack-External-Attendance.postman_collection.json), set `apiKey` locally, and choose dates and page numbers.

## Attendance fields

Existing daily, range and employee-history URLs now share the expanded response fields. Existing time, status and location fields remain available.

| Data | Fields |
| --- | --- |
| Identity | `attendance_id`, `employee_kind`, `employee_id`, `emp_id` (regular) or `professional_id`, `name`, `emp_code`, `phone` |
| Posting | `city_id`, `city`, `zone_id`, `zone`, `sector_id`, `ward_id`, `ward`, `kothi_id`, `kothi` |
| Employee role | `department`, `designation` on regular attendance; directory includes their IDs |
| Punches | `date`, `punch_in`, `punch_out`, `punch_in_time`, `punch_out_time`, `mid_shift_punch_in`, `mid_shift_punch_in_time`, `duration` (regular), `hours_worked` (professional) |
| Coordinates/address | `latitude_in`, `longitude_in`, `in_address`, `latitude_out`, `longitude_out`, `out_address`, mid-shift equivalents on regular attendance |
| Photo links | `punch_in_image_url`, `punch_out_image_url`, `mid_shift_punch_in_image_url` |
| Actor details | `punched_in_by`, `punched_out_by`, `mid_shift_punched_in_by`: object containing `id`, `type`, `name`, `emp_code`, `phone`, `email`, `photo_url` or `null` |
| Supervisor evidence | `supervisor_in_by`, `supervisor_out_by`, captured names, `supervisor_in_capture`, `supervisor_out_capture`; group evidence appears in the corresponding punch image URL |
| Register evidence | `register_status`, `register_request_id`, `register_marked_by`, `register_marked_by_name`, `register_marked_at`, `register_actor` |
| Result | `attendance_source`, `status`, `leave_type` (regular), `is_auto_punch_out` |
| Professional approval | `attempted_punch_in`, `punch_approval_status`; pending/rejected records have explicit statuses |
| Professional original posting | `original_city_id`, `original_zone_id`, `original_sector_id`, `original_kothi_id` |

Photo fields contain usable URLs instead of raw storage references. Attendance and private S3 links expire after 900 seconds; fetch the record again to refresh them. Legacy HTTP photo references retain their existing URL behavior. Missing evidence is `null`.
Supervisor group captures are signed only after attendance scope is enforced. Regular legacy photo links contain a short-lived capability bound to one attendance record, punch direction and image reference. Profile-photo URLs are also included for actors and directory entries.
Responses containing photos use `Cache-Control: private, no-store`. Never share API keys or photo URLs publicly.

`punch_in` and `punch_out` are clock times in `Asia/Kolkata`; `meta.timezone` makes this explicit. Professional timestamp fields preserve their offset. Regular legacy timestamp columns represent local wall time; use `date` and clock-time fields when displaying them.

Register attendance is a manual present/absent record: it has no fabricated punch times or punch images. `status: "Present"` and `register_status: "present"` indicate a valid Register mark even when `punch_in` is `null`.
Attendance endpoints return stored records, not a fabricated absent row for every employee. Use `/employees` to retrieve the complete registered roster, including employees without a mark.
Professional employee reports follow the current posting after transfer; original saved location IDs are also returned. Regular attendance remains scoped by its saved attendance site.

## Example supervisor-marked row

```json
{
  "success": true,
  "data": [{
    "attendance_id": "12345",
    "employee_kind": "regular",
    "employee_id": "123",
    "emp_id": 123,
    "name": "Example Employee",
    "emp_code": "EMP123",
    "date": "2026-10-28",
    "punch_in": "09:00:00",
    "punch_out": "18:00:00",
    "attendance_source": "supervisor",
    "status": "Completed",
    "punched_in_by": {
      "id": "10000000-0000-4000-8000-000000000001",
      "type": "professional",
      "name": "Example Project Head",
      "emp_code": "HEAD1",
      "phone": "9000000000",
      "email": "head@example.test",
      "photo_url": "https://example.test/signed-profile-photo"
    },
    "punch_in_image_url": "https://example.test/signed-group-photo",
    "punch_out_image_url": "https://example.test/signed-out-photo",
    "mid_shift_punch_in_image_url": null,
    "register_status": null
  }],
  "pagination": { "page": 1, "limit": 50, "total": 1, "total_pages": 1 },
  "meta": { "api_version": "v1", "timezone": "Asia/Kolkata", "image_url_expires_in_seconds": 900 }
}
```

Passwords, biometric embeddings, face-recognition IDs and identity documents are not added to these responses. The existing `/employees/:empId` Aadhaar field remains for compatibility; it is not included in attendance or directory lists.

## Validation

Run `npm run test:external-attendance` for local integration coverage, including API-key filters, both supervisor account types, photos, Register totals, transferred professional history and pagination.
`node scripts/verify-external-attendance-read.cjs 2026-10-28` checks query compatibility against the configured database in read-only mode, prints counts only, and substitutes photo signing so no storage calls or links are emitted.
