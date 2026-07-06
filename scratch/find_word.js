const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../routes/appRoutes/newAttendaceRoutes.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

lines.forEach((line, index) => {
  if (line.includes('loadFaceBuffer')) {
    console.log(`Line ${index + 1}: ${line.trim()}`);
  }
});
