/**
 * HMS Daily City Bulletin — pune_swm_daily_bulletin_report_hms  (38 body params)
 *
 * Scope: Road Sweeping Staff- PMC only, all zones in Pune city.
 *
 * Template parameter mapping:
 *  body_1  : Report date (DD Mon YYYY)
 *  body_2  : City status text  (e.g. "🟢 Strong Attendance Observed")
 *  body_3  : City status description
 *  body_4  : City total registered
 *  body_5  : City total present
 *  body_6  : City total on leave
 *  body_7  : City total absent
 *  body_8  : Zone 1 overview line  body_9: Zone 2  body_10: Zone 3  body_11: Zone 4  body_12: Zone 5
 *  body_13 : Zone 1 name  body_14: Z1 registered  body_15: Z1 present  body_16: Z1 leave  body_17: Z1 absent
 *  body_18 : Zone 2 name  body_19: Z2 registered  body_20: Z2 present  body_21: Z2 leave  body_22: Z2 absent
 *  body_23 : Zone 3 name  body_24: Z3 registered  body_25: Z3 present  body_26: Z3 leave  body_27: Z3 absent
 *  body_28 : Zone 4 name  body_29: Z4 registered  body_30: Z4 present  body_31: Z4 leave  body_32: Z4 absent
 *  body_33 : Zone 5 name  body_34: Z5 registered  body_35: Z5 present  body_36: Z5 leave  body_37: Z5 absent
 *  body_38 : Key observation line
 */

'use strict';

const { guardedReportPost } = require('./whatsappSettings');
const pool = require('../config/db');

const TEMPLATE_NAME = 'pune_swm_daily_bulletin_report_hms';
const TEMPLATE_NAMESPACE = process.env.MSG91_WHATSAPP_TEMPLATE_NAMESPACE || '5c8f516b_8ec5_4384_bb73_3bfd7a369e84';
const INTEGRATED_NUMBER = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER || '919111001035';
const BASE_URL = (process.env.MSG91_WHATSAPP_BASE_URL || 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk').replace(/\/+$/, '');
const DEPARTMENT = 'Road Sweeping Staff- PMC';
const REPORT_CITY = 'Pune';

const normalizePhone = (v) => {
    const d = String(v || '').replace(/\D/g, '');
    return d.length === 10 ? '91' + d : d;
};

const fmt = (n) => Number(n || 0).toLocaleString('en-IN');
const pct = (p, t) => (t ? `${((100 * p) / t).toFixed(1)}%` : '0.0%');

const previousDay = (now) => {
    const ref = now || new Date();
    const indiaDate = ref.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
    const d = new Date(`${indiaDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
};

const toDisplayDate = (iso) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
    });

// ─── Main data query ─────────────────────────────────────────────────────────
const ZONE_QUERY = `
WITH day_punch AS (
    SELECT a.emp_id,
        BOOL_OR(a.punch_in_time IS NOT NULL OR a.punch_out_time IS NOT NULL) AS present,
        BOOL_OR(a.leave_type IS NOT NULL) AS on_leave
    FROM attendance a
    WHERE a.date = $1::date
    GROUP BY a.emp_id
)
SELECT
    z.zone_name,
    z.zone_id,
    COUNT(DISTINCT e.emp_id)::int AS registered,
    COUNT(DISTINCT CASE WHEN COALESCE(dp.present, FALSE) THEN e.emp_id END)::int AS present,
    COUNT(DISTINCT CASE WHEN COALESCE(dp.on_leave, FALSE) AND NOT COALESCE(dp.present, FALSE) THEN e.emp_id END)::int AS on_leave,
    COUNT(DISTINCT CASE WHEN NOT COALESCE(dp.present, FALSE) AND NOT COALESCE(dp.on_leave, FALSE) THEN e.emp_id END)::int AS absent
FROM employee e
JOIN wards       w    ON w.ward_id          = e.ward_id
JOIN zones       z    ON z.zone_id          = w.zone_id
JOIN cities      c    ON c.city_id          = z.city_id
JOIN designation des  ON des.designation_id = e.designation_id
JOIN department  dept ON dept.department_id = des.department_id
LEFT JOIN day_punch dp ON dp.emp_id = e.emp_id
WHERE c.city_name ILIKE $2
  AND dept.department_name = $3
GROUP BY z.zone_name, z.zone_id
ORDER BY z.zone_name
`;

const generateHmsBulletinData = async (overrideDate) => {
    const iso = overrideDate || previousDay();
    const date = toDisplayDate(iso);

    const { rows } = await pool.query(ZONE_QUERY, [iso, REPORT_CITY, DEPARTMENT]);
    if (!rows.length) {
        throw new Error(`No Road Sweeping Staff data found for ${REPORT_CITY} on ${iso}.`);
    }

    // Map DB rows by zone number; pad to exactly 5 slots
    const zoneMap = new Map(rows.map((r) => [r.zone_name, r]));
    const zeroZone = (name) => ({ zone_name: name, registered: 0, present: 0, on_leave: 0, absent: 0 });
    const zones = [1, 2, 3, 4, 5].map((n) => {
        const row = [...zoneMap.values()].find((r) =>
            r.zone_name.toLowerCase().includes(`zone ${n}`)
        ) || zeroZone(`Zone ${n} (Pune)`);
        return {
            zoneName: row.zone_name,
            registered: Number(row.registered),
            present: Number(row.present),
            on_leave: Number(row.on_leave),
            absent: Number(row.absent),
        };
    });

    // City-level totals
    const cityReg = rows.reduce((s, r) => s + Number(r.registered), 0);
    const cityPresent = rows.reduce((s, r) => s + Number(r.present), 0);
    const cityLeave = rows.reduce((s, r) => s + Number(r.on_leave), 0);
    const cityAbsent = rows.reduce((s, r) => s + Number(r.absent), 0);
    const cityRate = cityReg ? (cityPresent / cityReg) * 100 : 0;

    const statusText = cityRate >= 70
        ? '🟢 Strong Attendance Observed'
        : cityRate >= 50
            ? '🟡 Attendance Variation Observed'
            : '🔴 Turnout Attention Required';

    const statusDesc = `Road sweeping workforce at ${pct(cityPresent, cityReg)} turnout across all zones in Pune today.`;

    // Zone overview lines sorted best → worst
    const sorted = [...zones].sort(
        (a, b) => (b.present / (b.registered || 1)) - (a.present / (a.registered || 1))
    );
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const overviewLines = sorted.map(
        (z, i) => `${medals[i]} ${z.zoneName} — ${fmt(z.present)} present (${pct(z.present, z.registered)})`
    );

    const bestZone = sorted[0];
    const worstZone = sorted.at(-1);
    const keyObservation =
        `${bestZone.zoneName} led with ${pct(bestZone.present, bestZone.registered)} attendance. ` +
        `${worstZone.zoneName} had the lowest turnout at ${pct(worstZone.present, worstZone.registered)}; ` +
        `focused follow-up required at ward level. Total ${fmt(cityAbsent)} workers absent city-wide.`;

    return {
        iso, date, statusText, statusDesc,
        cityReg, cityPresent, cityLeave, cityAbsent, cityRate,
        zones, overviewLines, keyObservation,
    };
};

// ─── MSG91 payload builder (38 params exactly) ───────────────────────────────
const buildPayload = (data, recipients) => {
    const z = (i) => data.zones[i] || { zoneName: '-', registered: 0, present: 0, on_leave: 0, absent: 0 };
    const ol = (i) => data.overviewLines[i] || '-';

    const components = {
        // City header — 7 params
        body_1: { type: 'text', value: data.date },
        body_2: { type: 'text', value: data.statusText },
        body_3: { type: 'text', value: data.statusDesc },
        body_4: { type: 'text', value: fmt(data.cityReg) },
        body_5: { type: 'text', value: fmt(data.cityPresent) },
        body_6: { type: 'text', value: fmt(data.cityLeave) },
        body_7: { type: 'text', value: fmt(data.cityAbsent) },
        // Zone overview lines — 5 params
        body_8: { type: 'text', value: ol(0) },
        body_9: { type: 'text', value: ol(1) },
        body_10: { type: 'text', value: ol(2) },
        body_11: { type: 'text', value: ol(3) },
        body_12: { type: 'text', value: ol(4) },
        // Zone 1 — 5 params
        body_13: { type: 'text', value: z(0).zoneName },
        body_14: { type: 'text', value: fmt(z(0).registered) },
        body_15: { type: 'text', value: fmt(z(0).present) },
        body_16: { type: 'text', value: fmt(z(0).on_leave) },
        body_17: { type: 'text', value: fmt(z(0).absent) },
        // Zone 2 — 5 params
        body_18: { type: 'text', value: z(1).zoneName },
        body_19: { type: 'text', value: fmt(z(1).registered) },
        body_20: { type: 'text', value: fmt(z(1).present) },
        body_21: { type: 'text', value: fmt(z(1).on_leave) },
        body_22: { type: 'text', value: fmt(z(1).absent) },
        // Zone 3 — 5 params
        body_23: { type: 'text', value: z(2).zoneName },
        body_24: { type: 'text', value: fmt(z(2).registered) },
        body_25: { type: 'text', value: fmt(z(2).present) },
        body_26: { type: 'text', value: fmt(z(2).on_leave) },
        body_27: { type: 'text', value: fmt(z(2).absent) },
        // Zone 4 — 5 params
        body_28: { type: 'text', value: z(3).zoneName },
        body_29: { type: 'text', value: fmt(z(3).registered) },
        body_30: { type: 'text', value: fmt(z(3).present) },
        body_31: { type: 'text', value: fmt(z(3).on_leave) },
        body_32: { type: 'text', value: fmt(z(3).absent) },
        // Zone 5 — 5 params
        body_33: { type: 'text', value: z(4).zoneName },
        body_34: { type: 'text', value: fmt(z(4).registered) },
        body_35: { type: 'text', value: fmt(z(4).present) },
        body_36: { type: 'text', value: fmt(z(4).on_leave) },
        body_37: { type: 'text', value: fmt(z(4).absent) },
        // Key observation — 1 param
        body_38: { type: 'text', value: data.keyObservation },
    };

    return {
        integrated_number: INTEGRATED_NUMBER,
        content_type: 'template',
        payload: {
            messaging_product: 'whatsapp',
            type: 'template',
            template: {
                name: TEMPLATE_NAME,
                namespace: TEMPLATE_NAMESPACE,
                language: { policy: 'deterministic', code: 'en' },
                to_and_components: [{ to: recipients, components }],
            },
        },
    };
};

// ─── Public send function ─────────────────────────────────────────────────────
const sendHmsDailyBulletin = async ({ phoneNumber, date }) => {
    const authkey = process.env.MSG91_WHATSAPP_AUTH_KEY || process.env.MSG91_AUTH_KEY;
    if (!authkey) throw new Error('MSG91 authentication is not configured.');

    const recipients = (Array.isArray(phoneNumber) ? phoneNumber : String(phoneNumber).split(','))
        .map(normalizePhone)
        .filter((p) => /^[1-9]\d{9,14}$/.test(p));
    if (!recipients.length) throw new Error('A valid phoneNumber is required.');

    const data = await generateHmsBulletinData(date);
    const payload = buildPayload(data, recipients);
    const url = `${BASE_URL}/`;

    const response = await guardedReportPost('hms-daily-bulletin', url, payload, {
        headers: { 'Content-Type': 'application/json', authkey },
        timeout: 15000,
    });

    if (response.data && (response.data.hasError || response.data.status !== 'success')) {
        throw new Error(`MSG91 rejected the HMS bulletin: ${JSON.stringify(response.data)}`);
    }

    return { providerResponse: response.data, reportData: data, phoneNumber: recipients.join(', ') };
};

module.exports = { sendHmsDailyBulletin, generateHmsBulletinData, previousDay };
