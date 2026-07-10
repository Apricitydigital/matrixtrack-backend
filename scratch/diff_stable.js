const fs = require('fs');
const path = require('path');

const currentFile = path.join(__dirname, '../routes/appRoutes/newAttendaceRoutes.js');
const stableFile = path.join(__dirname, 'stable_newAttendaceRoutes.js');

if (!fs.existsSync(currentFile)) {
  console.log('Current file does not exist');
}
if (!fs.existsSync(stableFile)) {
  console.log('Stable file does not exist');
}

if (fs.existsSync(currentFile) && fs.existsSync(stableFile)) {
  const c1 = fs.readFileSync(currentFile, 'utf8');
  const c2 = fs.readFileSync(stableFile, 'utf8');

  console.log('Current length:', c1.length);
  console.log('Stable length:', c2.length);

  // Let's do a diff of lines in the /face-attendance route (between lines 1962 and 2345 in current)
  // Let's find the /face-attendance route in both and print the difference or summary
  const startCurrent = c1.indexOf('router.post("/face-attendance"');
  const endCurrent = c1.indexOf('router.post("/face-liveness"');
  const currentFaceAttendance = startCurrent !== -1 && endCurrent !== -1 ? c1.substring(startCurrent, endCurrent) : '';

  const startStable = c2.indexOf('router.post("/face-attendance"');
  const endStable = c2.indexOf('router.post("/face-liveness"');
  const stableFaceAttendance = startStable !== -1 && endStable !== -1 ? c2.substring(startStable, endStable) : '';

  console.log('Current face-attendance route length:', currentFaceAttendance.length);
  console.log('Stable face-attendance route length:', stableFaceAttendance.length);

  if (currentFaceAttendance === stableFaceAttendance) {
    console.log('face-attendance routes are IDENTICAL!');
  } else {
    console.log('face-attendance routes are DIFFERENT!');
    // Save both sections to temp files so we can diff them
    fs.writeFileSync(path.join(__dirname, 'temp_current_face.js'), currentFaceAttendance);
    fs.writeFileSync(path.join(__dirname, 'temp_stable_face.js'), stableFaceAttendance);
  }
}
