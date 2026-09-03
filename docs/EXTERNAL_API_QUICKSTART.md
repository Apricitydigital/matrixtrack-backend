# External API v1 - Developer Quick Start

This API lets trusted integrations read attendance and manage attendance or regular employees. All endpoints use JSON and are mounted below:

```text
https://<your-backend-host>/api/v1/external
```

## Authentication

Send the API key on every request:

```http
x-api-key: hms_live_your_key_here
Content-Type: application/json
```

Treat the key like a password: keep it server-side, never put it in a mobile/web client, source control, or logs. An administrator can restrict a key by expiry date, allowed IP addresses, permissions, city, zone, and ward.

Available permissions:

| Permission | Allows |
|---|---|
| `attendance:read` | Read regular and professional attendance |
| `attendance:write` | Create, update, and delete regular or professional attendance |
| `employees:read` | List and view regular employees |
| `employees:write` | Create, update, and delete regular employees |

If a key is assigned to a city, zone, or ward, the API automatically filters reads and rejects writes outside that scope.

## First request

```bash
curl "https://<your-backend-host>/api/v1/external/health" \
  -H "x-api-key: hms_live_your_key_here"
```

Successful responses use:

```json
{
  "success": true,
  "data": {},
  "meta": {
    "api_version": "v1",
    "timestamp": "2026-09-02T10:00:00.000Z"
  }
}
```

Errors use:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_API_KEY",
    "message": "Invalid API key. Check your key and try again."
  }
}
```

## Endpoint reference

### Regular attendance

| Method | Path | Permission | Input |
|---|---|---|---|
| GET | `/attendance/daily` | `attendance:read` | Query: `date` (required), `page`, `limit`, optional `city_id`, `ward_id` |
| GET | `/attendance/range` | `attendance:read` | Query: `from`, `to` (required), `page`, `limit`, optional `city_id`; maximum 31 days |
| GET | `/attendance/summary` | `attendance:read` | Query: `date` (required) |
| GET | `/attendance/employee/:empId` | `attendance:read` | Query: `from`, `to` (required) |
| POST | `/attendance/punch-in` | `attendance:write` | Body: `emp_id`, `ward_id` required; optional `date`, `punch_in_time`, `latitude`, `longitude`, `address` |
| POST | `/attendance/punch-out` | `attendance:write` | Body: `emp_id` required; optional `date`, `punch_out_time`, `latitude`, `longitude`, `address` |
| POST | `/attendance/mark-leave` | `attendance:write` | Body: `emp_id`, `ward_id`, `leave_type` required; optional `date` |
| PUT | `/attendance/:attendanceId` | `attendance:write` | Body: one or more of `punch_in_time`, `punch_out_time`, `leave_type` |
| DELETE | `/attendance/:attendanceId` | `attendance:write` | No body |

Punch-in example:

```bash
curl -X POST "https://<your-backend-host>/api/v1/external/attendance/punch-in" \
  -H "x-api-key: hms_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"emp_id":123,"ward_id":9,"date":"2026-09-02","punch_in_time":"10:00:00"}'
```

### Professional attendance

| Method | Path | Permission | Input |
|---|---|---|---|
| GET | `/professional/attendance/daily` | `attendance:read` | Query: `date` (required), `page`, `limit` |
| POST | `/professional/attendance/punch-in` | `attendance:write` | Body: `professional_id` required; optional `date`, `latitude`, `longitude` |
| POST | `/professional/attendance/punch-out` | `attendance:write` | Body: `professional_id` required; optional `date`, `latitude`, `longitude` |
| PUT | `/professional/attendance/:id` | `attendance:write` | Body: `punch_in` and/or `punch_out` as ISO-8601 timestamps |
| DELETE | `/professional/attendance/:id` | `attendance:write` | No body |

Professional punch-in example:

```bash
curl -X POST "https://<your-backend-host>/api/v1/external/professional/attendance/punch-in" \
  -H "x-api-key: hms_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"professional_id":456,"date":"2026-09-02","latitude":26.9124,"longitude":75.7873}'
```

### Regular employees

| Method | Path | Permission | Input |
|---|---|---|---|
| GET | `/employees` | `employees:read` | Query: `page`, `limit`, optional `city_id` |
| GET | `/employees/:empId` | `employees:read` | No body |
| POST | `/employees` | `employees:write` | Body: `name`, `emp_code`, `ward_id` required; optional `phone`, `designation_id`, `aadhar_no` |
| PUT | `/employees/:empId` | `employees:write` | Body: any employee fields listed above |
| DELETE | `/employees/:empId` | `employees:write` | No body; fails if dependent records exist |

Create employee example:

```bash
curl -X POST "https://<your-backend-host>/api/v1/external/employees" \
  -H "x-api-key: hms_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"name":"Example Employee","emp_code":"EXT-1001","ward_id":9,"phone":"9876543210"}'
```

## Formats, pagination, and limits

- Dates: `YYYY-MM-DD`.
- Regular attendance times: `HH:mm:ss` in India time. If omitted on punch endpoints, the server uses the current India date/time.
- Professional edit timestamps: ISO-8601 with an explicit offset, for example `2026-09-02T10:00:00+05:30`.
- Paginated endpoints accept `page` and `limit`. Defaults are page `1`, limit `50`; maximum limit is `200`.
- The attendance range endpoint accepts at most 31 days per request.
- Current route limit is 120 requests per minute per source IP. A `429` response means the caller must wait and retry with backoff.
- `409 DUPLICATE` means attendance already exists or an employee code is already used. Do not blindly retry it.

## Important write-API behavior

Attendance write endpoints are intended for trusted administrative integrations. They write attendance directly and do not run the mobile app's face/liveness, geofence, group-punch, or device-session checks. Grant `attendance:write` only when that behavior is intended.

For safe integrations:

1. Use a separate key per integration with the minimum permissions and narrowest city/zone/ward scope.
2. Use an IP allow-list and expiry date where possible.
3. Before retrying a timed-out write, read the employee/date record to avoid duplicate operations.
4. Log the returned attendance or employee ID in the calling system.
5. Revoke the key immediately if it may have leaked.

## Common HTTP statuses

| Status | Meaning |
|---|---|
| `200` | Successful read/update/delete |
| `201` | Record created |
| `400` | Missing or invalid input |
| `401` | Missing or invalid API key |
| `403` | Revoked/expired key, blocked IP, missing permission, or out-of-scope record |
| `404` | Record not found |
| `409` | Duplicate or dependent records prevent the operation |
| `429` | Rate limit exceeded |
| `500` | Server error; retry only with bounded exponential backoff |

