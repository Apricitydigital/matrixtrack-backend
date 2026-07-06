const fs = require('fs');
const path = require('path');

const newFiles = [
  "controllers/professionalAttendanceController.js",
  "controllers/professionalAuthController.js",
  "controllers/professionalLeaveAllocationsController.js",
  "controllers/professionalLeaveController.js",
  "controllers/professionalLeaveManagementController.js",
  "controllers/professionalOtpController.js",
  "controllers/professionalPushController.js",
  "controllers/professionalReportsController.js",
  "controllers/publicDropdownController.js",
  "controllers/selfPunchController.js",
  "controllers/supervisorSelfPunchController.js",
  "middleware/professionalAuth.js",
  "middleware/supervisorAccess.js",
  "routes/professionalReportsRoutes.js",
  "routes/professionalRoutes.js",
  "routes/publicDropdownRoutes.js",
  "routes/publicSelfPunchRoutes.js",
  "routes/supervisorSelfPunchRoutes.js",
  "utils/encryption.js",
  "utils/faceService.js",
  "utils/logger.js",
  "utils/notificationService.js",
  "utils/professionalAccess.js",
  "utils/professionalLeaveSchema.js",
  "utils/professionalPunchInReminder.js",
  "utils/professionalPushService.js",
  "utils/s3SelfPunch.js",
  "utils/smsNotifier.js",
  "utils/socket.js",
  "utils/queryRunner.js",
  "db/migrations/20260505_self_punch_in_down.sql",
  "db/migrations/20260505_self_punch_in_up.sql",
  "db/migrations/20260514_link_department_cities.sql",
  "db/migrations/20260514_link_designation_cities.sql",
  "db/migrations/20260516_self_punch_uat_compat.sql",
  "db/migrations/20260519_relax_self_punch_mobile_pending.sql"
];

const backupDir = path.join(__dirname, "professional_backup");

for (const file of newFiles) {
  const srcPath = path.join(backupDir, file);
  const destPath = path.join(__dirname, "..", file);
  
  if (fs.existsSync(srcPath)) {
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(srcPath, destPath);
    console.log(`Restored: ${file}`);
  } else {
    console.log(`Warning: Backup not found for: ${file}`);
  }
}
console.log("\nNew files restored successfully!");
