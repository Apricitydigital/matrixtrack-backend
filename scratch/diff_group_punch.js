const fs = require("fs");
const { execSync } = require("child_process");

try {
  // Get main branch version of the file
  const mainFileContent = execSync(
    "git show main:routes/appRoutes/newAttendaceRoutes.js",
    { maxBuffer: 10 * 1024 * 1024 }
  ).toString();

  // Get current version of the file
  const currentFileContent = fs.readFileSync(
    "routes/appRoutes/newAttendaceRoutes.js",
    "utf8"
  );

  // Extract the face-attendance route block from a content string
  function extractFaceAttendanceRoute(content) {
    const startIdx = content.indexOf('router.post("/face-attendance"');
    if (startIdx === -1) return "Not found";
    
    // Find next route after face-attendance to mark the end of the block
    let endIdx = content.indexOf('router.post("/face-liveness"', startIdx);
    if (endIdx === -1) {
      endIdx = content.indexOf('router.post("/face-compare"', startIdx);
    }
    if (endIdx === -1) {
      endIdx = content.length;
    }
    
    return content.slice(startIdx, endIdx);
  }

  const mainRoute = extractFaceAttendanceRoute(mainFileContent);
  const currentRoute = extractFaceAttendanceRoute(currentFileContent);

  fs.writeFileSync("scratch/main_face_attendance.js", mainRoute);
  fs.writeFileSync("scratch/current_face_attendance.js", currentRoute);

  console.log("Extracted routes to scratch/main_face_attendance.js and scratch/current_face_attendance.js");
} catch (err) {
  console.error("Error executing script:", err);
}
