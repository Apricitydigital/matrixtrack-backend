const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '../debug-face.log');
if (fs.existsSync(logFile)) {
  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split('\n');
  
  console.log('Error/Warning search in debug-face.log:');
  lines.forEach((line, index) => {
    const l = line.toLowerCase();
    if (l.includes('error') || l.includes('exception') || l.includes('failed') || l.includes('timeout') || l.includes('throttled')) {
      // Check if it's not a normal expected logs
      if (!l.includes('non-fatal') && !l.includes('already exists') && !l.includes('clean_old_temp_files')) {
        console.log(`Line ${index + 1}: ${line.trim()}`);
      }
    }
  });
} else {
  console.log('debug-face.log does not exist');
}
