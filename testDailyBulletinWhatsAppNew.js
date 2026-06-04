// =========================================================================
// 🧪 NEW DAILY BULLETIN REPORT (V2) - TEST RUNNER SCRIPT (MULTILINE FORMAT)
// -------------------------------------------------------------------------
// This script triggers the V2 dynamic multi-line daily bulletin. To test:
//   node testDailyBulletinWhatsAppNew.js <phone_numbers> [optional_date]
// Example:
//   node testDailyBulletinWhatsAppNew.js 918827232995,919131042937
// =========================================================================
const { sendDailyBulletinWhatsAppNew } = require("./utils/msg91DailyBulletinNew");
const pool = require("./config/db");
require("dotenv").config();

// =========================================================================
// ⚙️ CONFIGURATION: Edit these default values for future testing
// =========================================================================
const DEFAULT_PHONE_NUMBER =
  "918827232995"; // 📞 Change this to your default phone number

// Helper to get Yesterday's date (Today - 1 day) in YYYY-MM-DD format (IST timezone)
const getYesterdayDateString = () => {
  const now = new Date();
  // Adjust to IST timezone (UTC+5:30)
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  istTime.setDate(istTime.getDate() - 1);
  return istTime.toISOString().split("T")[0];
};

// 📅 Default date: "Today - 1 day"
//  const DEFAULT_DATE = getYesterdayDateString();

// Note: If you want to force a specific hardcoded date for testing, you can uncomment below:
const DEFAULT_DATE = "2026-05-14";
// =========================================================================

async function main() {
  const args = process.argv.slice(2);
  const phoneNumber = args[0] || DEFAULT_PHONE_NUMBER;
  const overrideDate = args[1] || DEFAULT_DATE;

  if (!phoneNumber) {
    console.error("\x1b[31m%s\x1b[0m", "Error: Phone number is required (please configure DEFAULT_PHONE_NUMBER in the script or pass it as an argument).");
    console.log("\nUsage:");
    console.log("  node testDailyBulletinWhatsAppNew.js [phone_number] [optional_date_YYYY-MM-DD]");
    console.log("\nExamples:");
    console.log("  node testDailyBulletinWhatsAppNew.js");
    console.log(`  node testDailyBulletinWhatsAppNew.js ${DEFAULT_PHONE_NUMBER || "918827232995"} ${DEFAULT_DATE}`);
    process.exit(1);
  }

  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log("\x1b[36m%s\x1b[0m", "🚀 V2 PMC SWM Pune Daily Bulletin WhatsApp Test Script");
  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log(`Target Phone Number(s): ${phoneNumber}`);
  console.log(`Target Date: ${overrideDate}`);
  console.log("Fetching SWM data and sending V2 message via MSG91 WhatsApp API...\n");

  try {
    const result = await sendDailyBulletinWhatsAppNew({
      phoneNumber,
      date: overrideDate,
    });

    console.log("\x1b[32m%s\x1b[0m", "✔ V2 Daily Bulletin WhatsApp sent successfully!");
    console.log("\n--- MSG91 API RESPONSE ---");
    console.log(JSON.stringify(result.providerResponse, null, 2));

    console.log("\n--- REPORT DATA PREVIEW ---");
    console.log(`Date: ${result.reportData.date}`);
    console.log(`Status: ${result.reportData.statusText}`);
    console.log(`Desc: ${result.reportData.statusDesc}`);
    console.log(`Registered: ${result.reportData.cityRegistered}`);
    console.log(`Present: ${result.reportData.cityPresent}`);
    console.log(`Leave: ${result.reportData.cityLeave}`);
    console.log(`Absent: ${result.reportData.cityAbsent}`);

    console.log("\n--- RAW PREVIEW TEXT ---");
    console.log(result.reportData.rawPreviewText);

  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", "❌ Error sending V2 Daily Bulletin WhatsApp:");
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
