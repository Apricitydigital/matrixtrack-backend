const { isReportEnabled } = require('./whatsappSettings');
const { sendZoneCommissionerWhatsAppReport, previousReportDate } = require('./msg91ZoneCommissionerReport');
const { claimWhatsAppDispatch, releaseWhatsAppDispatch } = require('./whatsappDispatchGuard');
const zoneRecipients = (n, env = process.env) => {
    const raw = env[`WHATSAPP_ZONE_${n}_RECIPIENTS`] || env.WHATSAPP_DEFAULT_RECIPIENT || env.WHATSAPP_TEST_RECIPIENT || '9131042937';
    return [...new Set(
        raw.split(',')
            .map(x => x.replace(/\D/g, ''))
            .filter(Boolean)
            .map(x => x.length === 10 ? '91' + x : x)
    )];
};
const runZoneBriefs = async () => {
    if (!(await isReportEnabled('zone-commissioner'))) return;
    const dateISO = previousReportDate();
    for (let n = 1; n <= 5; n++) {
        const reportName = `zone-commissioner-zone-${n}`;
        if (!(await isReportEnabled(reportName))) continue;
        for (const phoneNumber of zoneRecipients(n)) {
            if (!/^[1-9]\d{9,14}$/.test(phoneNumber)) { console.error(`[Zone brief] Invalid configured recipient for Zone ${n}`); continue; }
            const identity = { reportName, reportDate: dateISO, recipientKey: phoneNumber };
            if (!(await claimWhatsAppDispatch(identity))) continue;
            try { await sendZoneCommissionerWhatsAppReport({ phoneNumber, zoneName: `Zone ${n}`, zoneData: { dateISO } }); }
            catch (error) {
                // Only release a known pre-send rejection. Keep uncertain provider outcomes claimed.
                if (error.code === 'REPORT_DISABLED') await releaseWhatsAppDispatch(identity);
                console.error(`[Zone brief] Zone ${n}: ${error.message}`);
            }
        }
    }
};
module.exports = { runZoneBriefs, zoneRecipients };
