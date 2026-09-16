const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { sendZoneCommissionerWhatsAppReport } = require("../utils/msg91ZoneCommissionerReport");

async function main() {
    let failed = 0;
    const phoneNumber = "9131042937";
    const zones = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Zone 5"];

    console.log(`Starting bulk dispatch of 5 Zone Commissioner reports to ${phoneNumber}...`);

    for (const zone of zones) {
        try {
            console.log(`\n----------------------------------------`);
            console.log(`[Dispatching] Sending report for ${zone}...`);
            const result = await sendZoneCommissionerWhatsAppReport({
                phoneNumber,
                zoneName: zone,
            });

            console.log(`[SUCCESS] ${zone} report sent!`);
            console.log(`Report Date: ${result.reportData.date}`);
            console.log(`Present/Total: ${result.reportData.present}/${result.reportData.totalReg} (${result.reportData.attendanceCompliance})`);
            console.log(`MSG91 Request ID: ${result.providerResponse?.request_id}`);
        } catch (error) {
            failed++;
            console.error(`[ERROR] Failed to send report for ${zone}:`, error.message);
        }
    }

    console.log(`\n========================================`);
    console.log(`All 5 Zone Commissioner report dispatches completed.`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error("Fatal error running script:", err);
    process.exit(1);
});
