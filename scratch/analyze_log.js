const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../debug-face.log');
if (fs.existsSync(logFile)) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n');
  
  let currentRequest = null;
  lines.forEach((line) => {
    if (line.includes('/face-attendance hit!')) {
      if (currentRequest) {
        console.log('--- Previous Request incomplete or concurrent ---');
      }
      currentRequest = {
        hit: line,
        buffers: [],
        results: null
      };
      console.log('HIT:', line);
    } else if (line.includes('loadFaceBuffer:')) {
      if (currentRequest) {
        currentRequest.buffers.push(line);
      }
    } else if (line.includes('Group Punch Results:')) {
      console.log('  Buffers loaded:', currentRequest ? currentRequest.buffers.length : 'N/A');
      console.log('  RESULTS:', line);
      currentRequest = null;
    } else if (line.includes('[face-attendance] Detected faces:')) {
      console.log('  ' + line.trim());
    } else if (line.includes('[face-attendance] groupMode:')) {
      console.log('  ' + line.trim());
    }
  });
} else {
  console.log('debug-face.log does not exist');
}
