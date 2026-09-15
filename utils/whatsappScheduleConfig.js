'use strict';
/**
 * whatsappScheduleConfig.js
 * DB-backed per-report schedule: recipients, send_time (HH:MM IST), days_of_week
 */

const pool = require('../config/db');

const SCHEDULABLE_REPORTS = [
    { id: 'zone-commissioner-zone-1', name: 'Zone 1 Commissioner Daily Brief' },
    { id: 'zone-commissioner-zone-2', name: 'Zone 2 Commissioner Daily Brief' },
    { id: 'zone-commissioner-zone-3', name: 'Zone 3 Commissioner Daily Brief' },
    { id: 'zone-commissioner-zone-4', name: 'Zone 4 Commissioner Daily Brief' },
    { id: 'zone-commissioner-zone-5', name: 'Zone 5 Commissioner Daily Brief' },
    { id: 'daily-city-report', name: 'Daily PMC Workforce Status' },
    { id: 'hms-daily-bulletin', name: 'HMS Daily City Bulletin' },
];

const VALID_IDS = new Set(SCHEDULABLE_REPORTS.map(r => r.id));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let tableReady = null;
const ensureTable = async () => {
    if (!tableReady) {
        tableReady = pool.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_schedule_config (
                report_id   TEXT        PRIMARY KEY,
                report_name TEXT        NOT NULL,
                recipients  TEXT        NOT NULL DEFAULT '',
                send_time   VARCHAR(5)  NOT NULL DEFAULT '07:30',
                days_of_week TEXT[]     NOT NULL DEFAULT '{}',
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `).then(() =>
            pool.query(
                `INSERT INTO whatsapp_schedule_config (report_id, report_name)
                 SELECT id, name FROM unnest($1::text[], $2::text[]) t(id, name)
                 ON CONFLICT (report_id) DO NOTHING`,
                [
                    SCHEDULABLE_REPORTS.map(r => r.id),
                    SCHEDULABLE_REPORTS.map(r => r.name),
                ]
            )
        ).catch(err => { tableReady = null; throw err; });
    }
    return tableReady;
};

const getAllSchedules = async () => {
    await ensureTable();
    const { rows } = await pool.query(
        `SELECT report_id, report_name, recipients, send_time, days_of_week, updated_at
         FROM whatsapp_schedule_config ORDER BY report_id`
    );
    return rows;
};

const getSchedule = async (reportId) => {
    await ensureTable();
    const { rows } = await pool.query(
        'SELECT * FROM whatsapp_schedule_config WHERE report_id = $1', [reportId]
    );
    return rows[0] || null;
};

/**
 * Save/update a report schedule.
 * @param {string} reportId
 * @param {{ reportName?, recipients: string, send_time: string, days_of_week: string[] }} data
 */
const saveSchedule = async (reportId, { reportName, recipients, send_time, days_of_week }) => {
    if (!VALID_IDS.has(reportId)) throw Object.assign(new Error('Unknown report ID.'), { statusCode: 400 });
    if (!/^\d{2}:\d{2}$/.test(send_time)) throw Object.assign(new Error('send_time must be HH:MM.'), { statusCode: 400 });
    const validDays = (days_of_week || []).filter(d => DAYS.includes(d));
    const safeRecipients = String(recipients || '').trim();
    await ensureTable();
    const { rows } = await pool.query(
        `INSERT INTO whatsapp_schedule_config (report_id, report_name, recipients, send_time, days_of_week, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (report_id) DO UPDATE SET
           report_name  = EXCLUDED.report_name,
           recipients   = EXCLUDED.recipients,
           send_time    = EXCLUDED.send_time,
           days_of_week = EXCLUDED.days_of_week,
           updated_at   = NOW()
         RETURNING *`,
        [
            reportId,
            reportName || SCHEDULABLE_REPORTS.find(r => r.id === reportId)?.name || reportId,
            safeRecipients,
            send_time,
            validDays,
        ]
    );
    return rows[0];
};

/** Parse recipients string to normalised E.164 array for India */
const parseRecipients = (str = '') =>
    str.split(',')
        .map(s => s.trim().replace(/\D/g, ''))
        .filter(Boolean)
        .map(d => d.length === 10 ? '91' + d : d)
        .filter(d => /^[1-9]\d{9,14}$/.test(d));

module.exports = { getAllSchedules, getSchedule, saveSchedule, parseRecipients, SCHEDULABLE_REPORTS, DAYS };
