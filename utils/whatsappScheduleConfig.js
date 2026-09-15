'use strict';
/**
 * whatsappScheduleConfig.js
 * Pattern B: In-Memory RAM Caching + DB Persistence
 *
 * Polling checks read from Node.js RAM memory (0 DB queries per minute).
 * Saving updates PostgreSQL DB AND refreshes RAM memory cache instantly.
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

// Pattern B: In-memory RAM cache initialized lazily or on server startup
let scheduleCache = null;
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

/** Load schedules from DB into RAM cache. */
const loadCacheFromDb = async () => {
    await ensureTable();
    const { rows } = await pool.query(
        `SELECT report_id, report_name, recipients, send_time, days_of_week, updated_at
         FROM whatsapp_schedule_config ORDER BY report_id`
    );
    scheduleCache = rows;
    return scheduleCache;
};

/**
 * Pattern B: Fast In-Memory read (0 DB queries when cached).
 * Forces DB refresh only if bypassCache is true.
 */
const getAllSchedules = async (bypassCache = false) => {
    if (!scheduleCache || bypassCache) {
        return await loadCacheFromDb();
    }
    return scheduleCache;
};

const getSchedule = async (reportId) => {
    const schedules = await getAllSchedules();
    return schedules.find(s => s.report_id === reportId) || null;
};

/**
 * Save/update a report schedule.
 * Updates DB AND refreshes in-memory RAM cache.
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

    // Refresh RAM cache after save
    await loadCacheFromDb();
    return rows[0];
};

/** Parse recipients string to normalised E.164 array for India */
const parseRecipients = (str = '') =>
    str.split(',')
        .map(s => s.trim().replace(/\D/g, ''))
        .filter(Boolean)
        .map(d => d.length === 10 ? '91' + d : d)
        .filter(d => /^[1-9]\d{9,14}$/.test(d));

module.exports = { getAllSchedules, getSchedule, saveSchedule, parseRecipients, loadCacheFromDb, SCHEDULABLE_REPORTS, DAYS };
