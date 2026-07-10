const fs = require('fs');

function readLastLines(filePath, lineCount) {
  try {
    const content = fs.readFileSync(filePath, 'utf16le'); // server.out is UTF-16LE
    const lines = content.split('\n');
    const lastLines = lines.slice(-lineCount);
    console.log(`Last ${lineCount} lines of ${filePath}:`);
    console.log(lastLines.join('\n'));
  } catch (err) {
    // Try utf8 if utf16le fails
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const lastLines = lines.slice(-lineCount);
      console.log(`Last ${lineCount} lines (UTF-8) of ${filePath}:`);
      console.log(lastLines.join('\n'));
    } catch (e) {
      console.error(e);
    }
  }
}

readLastLines('server.out', 100);
