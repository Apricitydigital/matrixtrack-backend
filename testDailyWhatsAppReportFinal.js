// =========================================================================
// 🧪 PMC PUNE SIMPLE DAILY REPORT - TEST RUNNER SCRIPT
// -------------------------------------------------------------------------
// This script triggers the daily report template "new_matrix_track_daily_whatsapp_report".
// To test:
//   node testDailyWhatsAppReportFinal.js <phone_number>
// Example:
//   node testDailyWhatsAppReportFinal.js 918827232995
// =========================================================================
const { sendDailyWhatsAppReportFinal } = require("./utils/msg91MatrixtrackDailyReport");
const pool = require("./config/db");
require("dotenv").config();

// =========================================================================
// ⚙️ CONFIGURATION: Edit this default value for testing
// =========================================================================
const DEFAULT_PHONE_NUMBER = "918827232995"; // 📞 Change this to your default phone number
// =========================================================================

async function main() {
  const args = process.argv.slice(2);
  const phoneNumber = args[0] || DEFAULT_PHONE_NUMBER;

  if (!phoneNumber) {
    console.error("\x1b[31m%s\x1b[0m", "Error: Phone number is required.");
    console.log("\nUsage:");
    console.log("  node testDailyWhatsAppReportFinal.js [phone_number]");
    console.log("\nExample:");
    console.log(`  node testDailyWhatsAppReportFinal.js ${DEFAULT_PHONE_NUMBER || "918827232995"}`);
    process.exit(1);
  }

  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log("\x1b[36m%s\x1b[0m", "🚀 PMC Pune Simple Daily Report WhatsApp Test Script");
  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log(`Target Phone Number: ${phoneNumber}`);
  console.log("Fetching daily SWM data and sending message via MSG91 WhatsApp API...\n");

  try {
    const result = await sendDailyWhatsAppReportFinal({
      phoneNumber,
    });

    console.log("\x1b[32m%s\x1b[0m", "✔ Simple Daily Report WhatsApp sent successfully!");
    console.log("\n--- MSG91 API RESPONSE ---");
    console.log(JSON.stringify(result.providerResponse, null, 2));

    console.log("\n--- REPORT DATA PREVIEW ---");
    console.log(`Date: ${result.reportData.date}`);
    console.log(`City Total: ${result.reportData.city.total}, Present: ${result.reportData.city.present}, Leave: ${result.reportData.city.onLeave}, Absent: ${result.reportData.city.absent}`);
    console.log(`Ramp Total: ${result.reportData.ramp.total}, Present: ${result.reportData.ramp.present}, Leave: ${result.reportData.ramp.onLeave}, Absent: ${result.reportData.ramp.absent}`);
    console.log(`PMC Total: ${result.reportData.pmc.total}, Present: ${result.reportData.pmc.present}, Leave: ${result.reportData.pmc.onLeave}, Absent: ${result.reportData.pmc.absent}`);

  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", "❌ Error sending Simple Daily Report WhatsApp:");
    console.error(error.message);
    if (error.response && error.response.data) {
      console.error("\nAPI Error Response Details:");
      console.error(JSON.stringify(error.response.data, null, 2));
    }
  } finally {
    // Close the PG database pool so the process can exit
    console.log("\nClosing database connection pool...");
    await pool.end();
    console.log("Process finished.");
  }
}

main();
