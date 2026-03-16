require("dotenv").config();

// Point internal API calls at the live deployed server instead of localhost
// (used when running this test script without the backend running locally)
process.env.INTERNAL_API_BASE_URL = "https://api.matrixtrack.in/api";

const { sendDailyWhatsAppReport } = require("./utils/msg91WhatsApp");

const TEST_PHONE = "9131042937";

(async () => {
    console.log("==============================================");
    console.log(" MatrixTrack WhatsApp Report - TEST SEND");
    console.log("==============================================");
    console.log(`Sending to: ${TEST_PHONE}`);
    console.log("----------------------------------------------");

    try {
        const { reportData, providerResponse } = await sendDailyWhatsAppReport({
            phoneNumber: TEST_PHONE,
        });

        console.log("\n✅ Report sent successfully!\n");
        console.log("--- Report Data (what was sent) ---");
        console.log(`City         : ${reportData.city}`);
        console.log(`Date         : ${reportData.date}`);
        console.log(`Registered   : ${reportData.registered}`);
        console.log(`Present      : ${reportData.present}`);
        console.log(`Absent       : ${reportData.absent}`);
        console.log(`-- Check: Registered = Present + Absent + Leave? `);
        console.log(`   ${reportData.registered} = ${reportData.present} + ${reportData.absent} (+ leave)`);
        console.log("--- Department Breakdown ---");
        console.log(`Ramp         : Present ${reportData.rampPresent}, Absent ${reportData.rampAbsent}`);
        console.log(`PMC          : Present ${reportData.pmcPresent}, Absent ${reportData.pmcAbsent}`);
        console.log(`Outsource    : Present ${reportData.outsourcePresent}, Absent ${reportData.outsourceAbsent}`);
        console.log(`Swach Emp.   : Present ${reportData.swachPresent}, Absent ${reportData.swachAbsent}`);
        console.log("--- Provider Response ---");
        console.log(JSON.stringify(providerResponse, null, 2));
    } catch (err) {
        console.error("\n❌ Error sending report:");
        console.error("  Message:", err.message);
        if (err.response?.data) {
            console.error("  Provider details:", JSON.stringify(err.response.data, null, 2));
        }
    }

    process.exit(0);
})();
