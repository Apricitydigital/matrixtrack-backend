const { guardedReportPost } = require('./whatsappSettings');
const pool = require('../config/db');

const TEMPLATE_NAME = 'matrix_track_pmc_zone_commissioner_daily_brief_neww';
const DEPARTMENT = 'Road Sweeping Staff- PMC';
const indiaNow = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
const previousReportDate = (now = new Date()) => {
    const indiaDate = now.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
    const date = new Date(`${indiaDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
};
const normalizePhoneNumber = (value = '') => {
    const digits = String(value).replace(/\D/g, '');
    return digits.length === 10 ? `91${digits}` : digits;
};
const percent = (value, total) => total ? `${(100 * value / total).toFixed(1)}%` : '0.0%';
const number = value => Number(value).toLocaleString('en-IN');
const comparison = (present, previousTotal) => {
    const average = previousTotal / 7;
    if (!average) return present ? 'up from zero in' : 'equal to';
    const difference = (present - average) / average * 100;
    return `${Math.abs(difference).toFixed(1)}% ${difference < 0 ? 'below' : 'above'}`;
};
const validateDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new Error('dateISO must be a valid YYYY-MM-DD date.');
    }
    return value;
};

// One row per employee/day prevents duplicate punches and leave rows from inflating counts.
// The previous seven calendar days exclude the report day and include days with zero punches.
const DATA_QUERY = `
WITH scoped AS (
    SELECT e.emp_id, w.ward_id, w.ward_name AS kothi_name,
        s.sector_id, COALESCE(s.sector_name, 'Ward not assigned') AS ward_name
    FROM employee e
    JOIN wards w ON w.ward_id = e.ward_id
    JOIN zones z ON z.zone_id = w.zone_id
    JOIN cities c ON c.city_id = z.city_id
    JOIN designation des ON des.designation_id = e.designation_id
    JOIN department dept ON dept.department_id = des.department_id
    LEFT JOIN sectors s ON s.sector_id = w.sector_id AND s.zone_id = z.zone_id
    WHERE c.city_name ILIKE '%Pune%'
      AND LOWER(z.zone_name) = LOWER($2)
      AND ($3::int IS NULL OR z.zone_id = $3)
      AND dept.department_name = $4
), daily AS (
    SELECT a.emp_id, a.date,
        BOOL_OR(a.punch_in_time IS NOT NULL OR a.punch_out_time IS NOT NULL) AS present,
        BOOL_OR(a.leave_type IS NOT NULL) AS on_leave,
        BOOL_OR(a.punch_out_time IS NOT NULL) AS punch_out,
        BOOL_OR((a.punch_in_time IS NOT NULL OR a.punch_out_time IS NOT NULL) AND
            CASE WHEN TRIM(a.latitude_in) ~ '^-?[0-9]+([.][0-9]+)?$'
                  AND TRIM(a.longitude_in) ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN a.latitude_in::numeric BETWEEN -90 AND 90
             AND a.longitude_in::numeric BETWEEN -180 AND 180
             AND NOT (a.latitude_in::numeric = 0 AND a.longitude_in::numeric = 0)
            ELSE FALSE END) AS gps
    FROM attendance a JOIN scoped e ON e.emp_id = a.emp_id
    WHERE a.date BETWEEN $1::date - 7 AND $1::date
    GROUP BY a.emp_id, a.date
), employee_stats AS (
    SELECT e.*,
        COALESCE(BOOL_OR(d.present) FILTER (WHERE d.date = $1::date), FALSE) AS present,
        COALESCE(BOOL_OR(d.on_leave) FILTER (WHERE d.date = $1::date), FALSE) AS on_leave,
        COALESCE(BOOL_OR(d.punch_out) FILTER (WHERE d.date = $1::date), FALSE) AS punch_out,
        COALESCE(BOOL_OR(d.gps) FILTER (WHERE d.date = $1::date), FALSE) AS gps,
        COUNT(*) FILTER (WHERE d.date < $1::date AND d.present) AS previous_present
    FROM scoped e LEFT JOIN daily d ON d.emp_id = e.emp_id
    GROUP BY e.emp_id, e.ward_id, e.kothi_name, e.sector_id, e.ward_name
)
SELECT ward_id, kothi_name, sector_id, ward_name,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE present)::int AS present,
    COUNT(*) FILTER (WHERE NOT present AND on_leave)::int AS on_leave,
    COUNT(*) FILTER (WHERE NOT present AND NOT on_leave)::int AS absent,
    COUNT(*) FILTER (WHERE present AND punch_out)::int AS punch_out,
    COUNT(*) FILTER (WHERE present AND gps)::int AS gps,
    SUM(previous_present)::int AS previous_present
FROM employee_stats
GROUP BY ward_id, kothi_name, sector_id, ward_name
ORDER BY ward_id`;

const buildReportData = (rows, supervisors, zoneName, dateISO, now = indiaNow()) => {
    if (!rows.length) throw new Error(`No registered road-sweeping workforce found for ${zoneName}.`);
    const fields = ['total', 'present', 'on_leave', 'absent', 'punch_out', 'gps', 'previous_present'];
    const total = Object.fromEntries(fields.map(key => [key, 0]));
    const wards = new Map();
    for (const row of rows) {
        const key = row.sector_id ?? `unassigned-${row.ward_id}`;
        if (!wards.has(key)) wards.set(key, { name: row.ward_name, ...Object.fromEntries(fields.map(k => [k, 0])) });
        for (const keyName of fields) {
            total[keyName] += Number(row[keyName]);
            wards.get(key)[keyName] += Number(row[keyName]);
        }
    }
    const rank = (a, b) => {
        const rateA = a.total ? a.present / a.total : 0;
        const rateB = b.total ? b.present / b.total : 0;
        if (rateB !== rateA) return rateB - rateA;
        if (b.present !== a.present) return b.present - a.present;
        const absentA = a.total - a.present;
        const absentB = b.total - b.present;
        if (absentA !== absentB) return absentA - absentB;
        return String(a.name || a.kothi_name).localeCompare(String(b.name || b.kothi_name));
    };
    const rankedWards = [...wards.values()].sort(rank);
    const kothis = [...rows].sort(rank);
    const best = rankedWards[0], worst = rankedWards.at(-1);
    const bestKothi = kothis[0], lowestKothi = kothis.at(-1);
    const supervisorCandidates = supervisors.map(s => {
        const assigned = rows.filter(r => s.ward_ids.map(Number).includes(Number(r.ward_id)));
        return { name: s.name, total: assigned.reduce((n, r) => n + Number(r.total), 0), present: assigned.reduce((n, r) => n + Number(r.present), 0) };
    }).filter(s => s.total).sort(rank);
    const supervisor = supervisorCandidates.at(-1);
    const attendance = total.present / total.total * 100;
    return {
        zoneName, zoneNumber: zoneName.match(/\d+$/)[0], dateISO, title: `${zoneName} Brief`,
        date: new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
        time: new Date(`${now.replace(' ', 'T')}+05:30`).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
        status: attendance >= 90 ? 'Strong Performance' : attendance < 75 ? 'Needs Immediate Attention' : 'Normal Performance',
        headlineCount: number(total.present), avgDiff: comparison(total.present, total.previous_present),
        totalReg: number(total.total), present: number(total.present), onLeave: number(total.on_leave), absent: number(total.absent),
        attendanceCompliance: percent(total.present, total.total),
        punchOutCompliance: total.present ? percent(total.punch_out, total.present) : 'No attendance recorded',
        gpsCapture: total.present ? percent(total.gps, total.present) : 'No attendance recorded',
        bestWard: best.name, bestWardPct: percent(best.present, best.total), bestWardAvgDiff: comparison(best.present, best.previous_present),
        attentionWard: worst.name, attentionWardPct: percent(worst.present, worst.total), attentionWardAvgDiff: comparison(worst.present, worst.previous_present),
        bestKothi: bestKothi.kothi_name, bestKothiWorkers: number(bestKothi.present), bestKothiPct: percent(bestKothi.present, bestKothi.total),
        lowestKothi: lowestKothi.kothi_name, lowestKothiWorkers: number(lowestKothi.present), lowestKothiPct: percent(lowestKothi.present, lowestKothi.total),
        action1: Number(lowestKothi.present) === 0
            ? `${lowestKothi.kothi_name}: no attendance recorded on the report date; verify deployment.`
            : `${lowestKothi.kothi_name}: ${percent(lowestKothi.present, lowestKothi.total)} attendance; review ${number(lowestKothi.absent)} absent workers.`,
        action2: total.present > total.punch_out
            ? `${number(total.present - total.punch_out)} present workers have no recorded punch-out; verify with supervisors.`
            : total.absent ? `${number(total.absent)} absent workers in ${zoneName}; verify attendance with supervisors.` : 'No missing punch-outs or unmarked absences recorded.',
        supervisorAttn: supervisor ? `${supervisor.name}: ${percent(supervisor.present, supervisor.total)} attendance across assigned locations in ${zoneName}; follow up.` : `No supervisor assignment found for ${zoneName}; review assignments.`,
        todayHighlight: total.present ? `${bestKothi.kothi_name}: ${number(bestKothi.present)} workers, ${percent(bestKothi.present, bestKothi.total)} attendance; highest location attendance rate.` : `No attendance recorded in ${zoneName} as of this report.`,
    };
};

const fetchZoneDataForRoadSweeping = async (zoneIdentifier = 'Zone 1', overrideDate = null, zoneId = null) => {
    const dateISO = validateDate(overrideDate || previousReportDate());
    const zoneName = String(zoneIdentifier).trim();
    if (!/^Zone\s+\d+$/i.test(zoneName)) throw new Error('zoneName must identify a zone, for example Zone 2.');
    if (zoneId !== null && (!Number.isInteger(Number(zoneId)) || Number(zoneId) <= 0)) throw new Error('zoneId must be a positive integer.');
    const { rows } = await pool.query(DATA_QUERY, [dateISO, zoneName, zoneId, DEPARTMENT]);
    const supervisors = rows.length ? await pool.query(`
        SELECT u.user_id, u.name, ARRAY_AGG(DISTINCT sw.ward_id) AS ward_ids
        FROM supervisor_ward sw JOIN users u ON u.user_id = sw.supervisor_id
        WHERE sw.ward_id = ANY($1::int[]) GROUP BY u.user_id, u.name`, [rows.map(r => r.ward_id)]) : { rows: [] };
    return buildReportData(rows, supervisors.rows, zoneName.replace(/^zone/i, 'Zone'), dateISO);
};

const COMPONENT_FIELDS = ['zoneNumber', 'date', 'time', 'status', 'headlineCount', 'avgDiff', 'totalReg', 'present', 'onLeave', 'absent', 'attendanceCompliance', 'punchOutCompliance', 'gpsCapture', 'bestWard', 'bestWardPct', 'bestWardAvgDiff', 'attentionWard', 'attentionWardPct', 'attentionWardAvgDiff', 'bestKothi', 'bestKothiWorkers', 'bestKothiPct', 'lowestKothi', 'lowestKothiWorkers', 'lowestKothiPct', 'action1', 'action2', 'supervisorAttn', 'todayHighlight'];
const buildComponents = report => Object.fromEntries(COMPONENT_FIELDS.map((field, index) => {
    if (report[field] === undefined || report[field] === null || String(report[field]).trim() === '' || report[field] === 'N/A') throw new Error(`Report field ${field} is missing.`);
    return [`body_${index + 1}`, { type: 'text', value: String(report[field]).replace(/\s+/g, ' ').trim() }];
}));

const sendZoneCommissionerWhatsAppReport = async ({ phoneNumber, zoneName, zoneData = {} }) => {
    const targetZoneName = zoneName || zoneData.zoneName || 'Zone 1';
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!/^[1-9]\d{9,14}$/.test(normalizedPhone)) throw new Error('A valid phoneNumber is required.');
    const authkey = process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;
    if (!authkey) throw new Error('MSG91 authentication is not configured.');
    // Scope/date are inputs; calculated metrics cannot be replaced with stale or sample values.
    const reportData = await fetchZoneDataForRoadSweeping(targetZoneName, zoneData.dateISO, zoneData.zoneId ?? null);
    const payload = {
        integrated_number: process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER || '919111001035', content_type: 'template',
        payload: {
            messaging_product: 'whatsapp', type: 'template', template: {
                name: TEMPLATE_NAME, namespace: process.env.MSG91_WHATSAPP_TEMPLATE_NAMESPACE || '5c8f516b_8ec5_4384_bb73_3bfd7a369e84',
                language: { policy: 'deterministic', code: 'en' },
                to_and_components: [{ to: [normalizedPhone], components: buildComponents(reportData) }],
            }
        },
    };
    const url = (process.env.MSG91_WHATSAPP_BASE_URL || 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk').replace(/\/+$/, '') + '/';
    const response = await guardedReportPost(['zone-commissioner', `zone-commissioner-zone-${reportData.zoneNumber}`], url, payload, { headers: { 'Content-Type': 'application/json', authkey }, timeout: 15000 });
    if (response.data.hasError || response.data.status !== 'success') throw new Error(`WhatsApp provider rejected report: ${JSON.stringify(response.data)}`);
    return { providerResponse: response.data, phoneNumber: normalizedPhone, reportData };
};

module.exports = { sendZoneCommissionerWhatsAppReport, fetchZoneDataForRoadSweeping, normalizePhoneNumber, buildReportData, buildComponents, comparison, validateDate, previousReportDate };
