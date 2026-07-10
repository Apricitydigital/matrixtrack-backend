const fs = require('fs');
const readline = require('readline');

async function findPattern(pattern) {
  const fileStream = fs.createReadStream('d:/HumanMatrixSolutions/MatrixTrack/attendease-backend/routes/appRoutes/newAttendaceRoutes.js');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    if (line.includes(pattern)) {
      console.log(`${lineNumber}: ${line.trim()}`);
    }
  }
}

const args = process.argv.slice(2);
findPattern(args[0] || 'validatePunchSession');
