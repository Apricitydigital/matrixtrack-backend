const pool = require('../config/db');
const axios = require('axios');
const REPORT_IDS = ['zone-commissioner', ...[1,2,3,4,5].map(n => `zone-commissioner-zone-${n}`), 'daily-city-report', 'daily-final-report', 'weekly-report', 'supervisor-daily-report'];
const validateId = id => {
    if (!REPORT_IDS.includes(id)) throw Object.assign(new Error('Unknown reportId.'), {statusCode:400});
};
// A factory permits tests to exercise the real send gate with a fake transport.
const createSettingsStore = (db, transport = axios) => {
    let ready;
    const ensureSettingsTable = async () => {
        if (!ready) ready = (async () => {
            await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_report_settings (
                report_id TEXT PRIMARY KEY, report_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await db.query(`INSERT INTO whatsapp_report_settings (report_id, report_name)
                SELECT id, id FROM unnest($1::text[]) id ON CONFLICT (report_id) DO NOTHING`, [REPORT_IDS]);
        })().catch(error => { ready = null; throw error; });
        await ready;
    };
    const getReportSettings = async () => {
        await ensureSettingsTable();
        return (await db.query('SELECT report_id, report_name, status, updated_at FROM whatsapp_report_settings')).rows;
    };
    const isReportEnabled = async id => {
        validateId(id);
        try {
            await ensureSettingsTable();
            const {rows} = await db.query('SELECT status FROM whatsapp_report_settings WHERE report_id = $1', [id]);
            return rows[0]?.status === 'active';
        } catch (error) {
            console.error('WhatsApp settings unavailable; sending blocked:', error.message);
            return false;
        }
    };
    const setReportStatus = async (id, name, status) => {
        validateId(id);
        if (!['active','inactive'].includes(status)) throw Object.assign(new Error('status must be active or inactive.'), {statusCode:400});
        await ensureSettingsTable();
        // UPDATE waits for a send already holding this row. Once this returns inactive,
        // later sends cannot pass the gate, even in another server process.
        const {rows} = await db.query(`UPDATE whatsapp_report_settings SET status=$2,
            report_name=$3, updated_at=NOW() WHERE report_id=$1 RETURNING *`, [id,status,name || id]);
        return rows[0];
    };
    const guardedReportPost = async (ids, ...args) => {
        ids = [...new Set(Array.isArray(ids) ? ids : [ids])].sort();
        ids.forEach(validateId);
        await ensureSettingsTable();
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const {rows} = await client.query(`SELECT report_id, status FROM whatsapp_report_settings
                WHERE report_id = ANY($1::text[]) ORDER BY report_id FOR UPDATE`, [ids]);
            if (rows.length !== ids.length || rows.some(r => r.status !== 'active')) {
                throw Object.assign(new Error('This WhatsApp report is inactive. No message sent.'), {statusCode:403, code:'REPORT_DISABLED'});
            }
            const response = await transport.post(...args);
            await client.query('COMMIT');
            return response;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    };
    return {ensureSettingsTable,getReportSettings,isReportEnabled,setReportStatus,guardedReportPost};
};
module.exports = {...createSettingsStore(pool), createSettingsStore, REPORT_IDS};
