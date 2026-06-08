// =========================================================================
// 🧪 PMC PUNE MONTHLY REPORT - TEST RUNNER SCRIPT
// -------------------------------------------------------------------------
// This script triggers the new monthly report template "pune_activity_monthly_report".
// To test:
//   node testMonthlyReportPune.js <phone_numbers> [optional_month]
// Example:
//   node testMonthlyReportPune.js 918827232995,919131042937
//   node testMonthlyReportPune.js 918827232995 2026-05
// =========================================================================
const { sendMonthlyReportWhatsApp } = require("./utils/MT Monthly Report pune");
const pool = require("./config/db");
require("dotenv").config();

// =========================================================================
// ⚙️ CONFIGURATION: Edit these default values for future testing
// =========================================================================
const DEFAULT_PHONE_NUMBER = "918827232995"; // 📞 Change this to your default phone number
const DEFAULT_MONTH = "2026-05"; // 📅 Default test month: May 2026
// =========================================================================

async function main() {
  const args = process.argv.slice(2);
  const phoneNumber = args[0] || DEFAULT_PHONE_NUMBER;
  const overrideMonth = args[1] || DEFAULT_MONTH;

  if (!phoneNumber) {
    console.error("\x1b[31m%s\x1b[0m", "Error: Phone number is required.");
    console.log("\nUsage:");
    console.log("  node testMonthlyReportPune.js [phone_number] [optional_month_YYYY-MM]");
    console.log("\nExamples:");
    console.log("  node testMonthlyReportPune.js");
    console.log(`  node testMonthlyReportPune.js ${DEFAULT_PHONE_NUMBER || "918827232995"} ${DEFAULT_MONTH}`);
    process.exit(1);
  }

  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log("\x1b[36m%s\x1b[0m", "🚀 PMC Pune Monthly Report WhatsApp Test Script");
  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log(`Target Phone Number(s): ${phoneNumber}`);
  console.log(`Target Month: ${overrideMonth}`);
  console.log("Fetching monthly data and sending message via MSG91 WhatsApp API...\n");

  try {
    const result = await sendMonthlyReportWhatsApp({
      phoneNumber,
      month: overrideMonth,
    });

    console.log("\x1b[32m%s\x1b[0m", "✔ Monthly Report WhatsApp sent successfully!");
    console.log("\n--- MSG91 API RESPONSE ---");
    console.log(JSON.stringify(result.providerResponse, null, 2));

    console.log("\n--- REPORT DATA PREVIEW ---");
    console.log(`Month: ${result.reportData.monthName}`);
    console.log(`Period: ${result.reportData.displayPeriod}`);
    console.log(`Top Zone: ${result.reportData.topZone}`);
    console.log(`Monthly Attendance: ${result.reportData.monthlyAttendance}%`);
    console.log(`Performance Trend: ${result.reportData.performanceTrend}`);

    console.log("\n--- RAW PREVIEW TEXT ---");
    console.log(result.rawPreviewText);

  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", "❌ Error sending Monthly Report WhatsApp:");
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
