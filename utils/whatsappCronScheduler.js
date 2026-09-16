'use strict';
/**
 * whatsappCronScheduler.js
 *
 * Reads schedule config from DB every minute.
 * Fires each report whose send_time matches current IST HH:MM and current day is in days_of_week.
 * Uses pg advisory locks so multi-process deployments fire exactly once.
 */

const { getAllSchedules, parseRecipients } = require('./whatsappScheduleConfig');
const { isReportEnabled } = require('./whatsappSettings');
const { claimWhatsAppDispatch, releaseWhatsAppDispatch } = require('./whatsappDispatchGuard');
const { sendZoneCommissionerWhatsAppReport, previousReportDate } = require('./msg91ZoneCommissionerReport');
const { sendDailyBulletinWhatsAppNew } = require('./msg91DailyBulletinNew');
const { sendHmsDailyBulletin } = require('./msg91HmsDailyBulletin');
const pool = require('../config/db');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const istNow = () => {
    const n = new Date();
    const str = n.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const [datePart, timePart] = str.split(' ');
    const [hh, mm] = timePart.split(':');
    const day = n.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
    return { hhmm: `${hh}:${mm}`, day, date: datePart };
};

/** Dispatch a single configured report to all configured recipients. */
const dispatchReport = async (cfg) => {
    const recipients = parseRecipients(cfg.recipients);
    if (!recipients.length) {
        console.log(`[WASched] ${cfg.report_id}: no recipients configured, skipping.`);
        return;
    }

    const enabled = await isReportEnabled(cfg.report_id);
    if (cfg.report_id.startsWith('zone-commissioner-zone-') && !(await isReportEnabled('zone-commissioner'))) return;
    if (!enabled) {
        console.log(`[WASched] ${cfg.report_id}: disabled in settings, skipping.`);
        return;
    }

    const dateISO = previousReportDate();

    // Zone Commissioner briefs — send to each recipient
    const zoneMatch = cfg.report_id.match(/^zone-commissioner-zone-(\d+)$/);
    if (zoneMatch) {
        const zoneNum = zoneMatch[1];
        const zoneName = `Zone ${zoneNum}`;
        for (const phoneNumber of recipients) {
            const identity = { reportName: cfg.report_id, reportDate: dateISO, recipientKey: phoneNumber };
            if (!(await claimWhatsAppDispatch(identity))) continue;
            try {
                await sendZoneCommissionerWhatsAppReport({ phoneNumber, zoneName, zoneData: { dateISO } });
                console.log(`[WASched] ${cfg.report_id}: sent to ${phoneNumber} for ${dateISO}`);
            } catch (err) {
                if (err.code === 'REPORT_DISABLED') await releaseWhatsAppDispatch(identity);
                console.error(`[WASched] ${cfg.report_id} → ${phoneNumber}: ${err.message}`);
            }
        }
        return;
    }

    // Daily PMC Workforce Status
    if (cfg.report_id === 'daily-city-report') {
        const identity = { reportName: 'daily-city-report', reportDate: dateISO, recipientKey: 'bulk' };
        if (!(await claimWhatsAppDispatch(identity))) return;
        try {
            await sendDailyBulletinWhatsAppNew({ phoneNumber: recipients, date: dateISO });
            console.log(`[WASched] daily-city-report: bulk sent to ${recipients.length} recipients for ${dateISO}`);
        } catch (err) {
            if (err.code === 'REPORT_DISABLED') await releaseWhatsAppDispatch(identity);
            console.error(`[WASched] daily-city-report: ${err.message}`);
        }
        return;
    }

    // HMS Daily City Bulletin
    if (cfg.report_id === 'hms-daily-bulletin') {
        const identity = { reportName: 'hms-daily-bulletin', reportDate: dateISO, recipientKey: 'bulk' };
        if (!(await claimWhatsAppDispatch(identity))) return;
        try {
            await sendHmsDailyBulletin({ phoneNumber: recipients, date: dateISO });
            console.log(`[WASched] hms-daily-bulletin: bulk sent to ${recipients.length} recipients for ${dateISO}`);
        } catch (err) {
            if (err.code === 'REPORT_DISABLED') await releaseWhatsAppDispatch(identity);
            console.error(`[WASched] hms-daily-bulletin: ${err.message}`);
        }
        return;
    }

    console.warn(`[WASched] No send handler for report_id="${cfg.report_id}"`);
};

/** Called every minute by node-cron in app.js. */
const runScheduledWhatsAppReports = async () => {
    const { hhmm, day, date } = istNow();
    let schedules;
    try {
        schedules = await getAllSchedules();
    } catch (err) {
        console.error('[WASched] Could not load schedules from DB:', err.message);
        return;
    }

    const due = schedules.filter(s =>
        s.send_time === hhmm &&
        Array.isArray(s.days_of_week) &&
        s.days_of_week.includes(day) &&
        s.recipients && s.recipients.trim()
    );

    if (!due.length) return;

    console.log(`[WASched] ${hhmm} IST (${day}) — ${due.length} report(s) due:`, due.map(s => s.report_id).join(', '));

    // Run in parallel — each report in its own error boundary
    await Promise.allSettled(due.map(cfg =>
        dispatchReport(cfg).catch(err =>
            console.error(`[WASched] Unhandled error for ${cfg.report_id}:`, err.message)
        )
    ));
};

module.exports = { runScheduledWhatsAppReports };
