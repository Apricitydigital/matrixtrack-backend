// =========================================================================
// 🧪 OLD DAILY BULLETIN REPORT (V1) - TEST RUNNER SCRIPT
// -------------------------------------------------------------------------
// This script triggers the V1 daily bulletin. To test it, run:
//   node testDailyBulletinWhatsApp.js <phone_numbers> [optional_date]
// Example:
//   node testDailyBulletinWhatsApp.js 918827232995,919131042937
// =========================================================================
const { sendDailyBulletinWhatsApp } = require("./utils/msg91DailyBulletin");
const pool = require("./config/db");
require("dotenv").config();

async function main() {
  const args = process.argv.slice(2);
  const phoneNumber = args[0];
  const overrideDate = args[1]; // optional YYYY-MM-DD

  if (!phoneNumber) {
    console.error("\x1b[31m%s\x1b[0m", "Error: Phone number is required.");
    console.log("\nUsage:");
    console.log("  node testDailyBulletinWhatsApp.js <phone_number> [optional_date_YYYY-MM-DD]");
    console.log("\nExamples:");
    console.log("  node testDailyBulletinWhatsApp.js 919876543210");
    console.log("  node testDailyBulletinWhatsApp.js 919876543210 2026-05-31");
    console.log("\nConfiguration Status:");
    console.log(`  - MSG91 AUTH KEY: ${process.env.MSG91_AUTH_KEY ? "Loaded (Starts with: " + process.env.MSG91_AUTH_KEY.substring(0, 6) + "...)" : "MISSING"}`);
    console.log(`  - Integrated Number: ${process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER || "919111001035"}`);
    console.log(`  - DB Host: ${process.env.DB_HOST}`);
    console.log(`  - DB Name: ${process.env.DB_NAME}\n`);
    process.exit(1);
  }

  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log("\x1b[36m%s\x1b[0m", "🚀 PMC SWM Pune Daily Bulletin WhatsApp Test Script");
  console.log("\x1b[36m%s\x1b[0m", "--------------------------------------------------");
  console.log(`Target Phone Number: ${phoneNumber}`);
  console.log(`Target Date: ${overrideDate || "Yesterday (default)"}`);
  console.log("Fetching SWM data and sending message via MSG91 WhatsApp API...\n");

  try {
    const result = await sendDailyBulletinWhatsApp({
      phoneNumber,
      date: overrideDate,
    });

    console.log("\x1b[32m%s\x1b[0m", "✔ Daily Bulletin WhatsApp sent successfully!");
    console.log("\n--- MSG91 API RESPONSE ---");
    console.log(JSON.stringify(result.providerResponse, null, 2));

    console.log("\n--- REPORT DATA PREVIEW ---");
    console.log(`Date: ${result.reportData.date}`);
    console.log(`Status: ${result.reportData.statusText}`);
    console.log(`Registered: ${result.reportData.cityRegistered}`);
    console.log(`Present: ${result.reportData.cityPresent}`);
    console.log(`Leave: ${result.reportData.cityLeave}`);
    console.log(`Absent: ${result.reportData.cityAbsent}`);

    console.log("\n--- RAW PREVIEW TEXT ---");
    console.log(result.reportData.rawPreviewText);

  } catch (error) {
    console.error("\x1b[31m%s\x1b[0m", "❌ Error sending Daily Bulletin WhatsApp:");
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
