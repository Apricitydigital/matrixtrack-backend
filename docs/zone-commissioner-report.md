# Zone Commissioner brief

`POST /whatsapp/zone-commissioner` accepts `phoneNumber` and `zoneData`:

```json
{"phoneNumber":"9131042937","zoneData":{"zoneName":"Zone 2","dateISO":"2026-09-11"}}
```

- Defaults to yesterday's date in Asia/Kolkata and Zone 1. Set `zoneName` for every other zone. Optional `zoneId` restricts to a specific database zone ID as well.
- Retains the existing Pune city-name scope and Road Sweeping Staff- PMC department. Equal zone names in matching cities are combined unless `zoneId` is supplied; partial zone-name matching is no longer used.
- Uses current registered workforce assignments. Attendance is deduplicated per employee and date; a present employee is not also counted on leave.
- In this schema, sectors are report wards and wards are report kothis/locations.
- Seven-day comparisons use the prior seven calendar days, excluding report day, including zero-attendance days. These are full-day historical counts compared with the report's current count, not same-time-of-day comparisons.
- Ward and kothi rankings include zero attendance. Supervisor attendance aggregates the supervisor's assigned locations within the report scope.
- Missing punch-outs are flagged for supervisor verification on the report date. Actions are based on observed counts, not invented multi-day incidents.
- Database failures stop sending. Request-supplied totals and sample text cannot override computed metrics. Names are whitespace-normalized, not cut off.

MSG91 template: `matrix_track_pmc_zone_commissioner_daily_brief_neww`.
The first body variable is now the numeric zone (`2`), used by the template in `Zone {{1}} Brief`, the date line and the headline. The template edit must be approved before sending. The other 28 variable positions are unchanged.

Run `node --test scripts/test-zone-commissioner-report.js` for calculation and component checks.

## Sending controls and deployment

Every report utility now goes through `guardedReportPost` immediately before its MSG91 request. Inactive settings, missing locked rows, or database errors block dispatch. The settings update waits for an already-started provider request; a message already submitted to MSG91 cannot be recalled. The zone master switch and individual zone switch both apply to manual, bulk, script and scheduled sends.

The settings API requires admin authentication and validates report IDs/status values. The frontend loads server settings, disables controls on load failure, and no longer displays invented recipient counts or last-send timestamps. Supervisor sending is unavailable on this page because its route and cron are not configured.

Zone scheduling reads the saved time, weekdays and recipients from `whatsapp_schedule_config` every minute while `WHATSAPP_CRON_ENABLED=true` on the primary cron process. Configure these fields through the report page. Empty weekdays or recipients mean no scheduled sends. Database dispatch claims suppress repeat scheduled sends for the same zone, recipient and report date; ambiguous provider failures stay claimed to avoid duplicate retries.

Deploy/restart the backend and deploy the frontend together. Local source changes do not patch already running backend instances. All sending instances must run the new guard for shared Active/Inactive controls to apply. `whatsapp_report_settings` is initialized lazily without overwriting existing status choices.

Checks: `node --test scripts/test-whatsapp-settings.js scripts/test-zone-commissioner-report.js scripts/test-zone-brief-scheduler.js`.
