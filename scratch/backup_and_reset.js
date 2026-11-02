const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const filesToBackup = [
  "app.js",
  "config/awsConfig.js",
  "config/db.js",
  "config/redis.js",
  "controllers/selfAttendanceRecordsController.js",
  "controllers/selfAttendanceAuthController.js",
  "controllers/selfAttendanceLeaveAllocationsController.js",
  "controllers/selfAttendanceLeaveController.js",
  "controllers/selfAttendanceLeaveManagementController.js",
  "controllers/selfAttendanceOtpController.js",
  "controllers/selfAttendancePushController.js",
  "controllers/selfAttendanceReportsController.js",
  "controllers/publicDropdownController.js",
  "controllers/selfPunchController.js",
  "controllers/supervisorSelfPunchController.js",
  "db/migrations.js",
  "db/migrations/20260505_self_punch_in_down.sql",
  "db/migrations/20260505_self_punch_in_up.sql",
  "db/migrations/20260514_link_department_cities.sql",
  "db/migrations/20260514_link_designation_cities.sql",
  "db/migrations/20260516_self_punch_uat_compat.sql",
  "db/migrations/20260519_relax_self_punch_mobile_pending.sql",
  "middleware/permissionMiddleware.js",
  "middleware/selfAttendanceAuth.js",
  "middleware/supervisorAccess.js",
  "package.json",
  "package-lock.json",
  "routes/appRoutes/faceRoutes.js",
  "routes/index.js",
  "routes/selfAttendanceReportsRoutes.js",
  "routes/selfAttendanceRoutes.js",
  "routes/publicDropdownRoutes.js",
  "routes/publicSelfPunchRoutes.js",
  "routes/supervisorSelfPunchRoutes.js",
  "utils/encryption.js",
  "utils/faceService.js",
  "utils/logger.js",
  "utils/notificationService.js",
  "utils/otpService.js",
  "utils/selfAttendanceAccess.js",
  "utils/selfAttendanceLeaveSchema.js",
  "utils/selfAttendancePunchInReminder.js",
  "utils/selfAttendancePushService.js",
  "utils/queryRunner.js",
  "utils/rbacSetup.js",
  "utils/s3SelfPunch.js",
  "utils/smsNotifier.js",
  "utils/socket.js"
];

const backupDir = path.join(__dirname, "self_attendance_backup");

console.log("Starting backup to:", backupDir);

if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Copy files preserving directory structure
for (const file of filesToBackup) {
  const srcPath = path.join(__dirname, "..", file);
  if (fs.existsSync(srcPath)) {
    const destPath = path.join(backupDir, file);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(srcPath, destPath);
    console.log(`Backed up: ${file}`);
  } else {
    console.log(`Skipped (does not exist): ${file}`);
  }
}

console.log("\nBackup complete! Now resetting git workspace to fe49f6b9b3f16c92ba1a8028bd087ed09aa57c62...");

try {
  execSync("git reset --hard fe49f6b9b3f16c92ba1a8028bd087ed09aa57c62", { cwd: path.join(__dirname, ".."), stdio: 'inherit' });
  console.log("\nSuccessfully reset to stable commit fe49f6b9b3f16c92ba1a8028bd087ed09aa57c62!");
} catch (err) {
  console.error("Git reset failed:", err.message);
}
