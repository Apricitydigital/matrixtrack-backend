const fs = require('fs');
const path = require('path');

const file1Path = path.join(__dirname, '../routes/appRoutes/newAttendaceRoutes.js');
const file2Path = 'd:/HumanMatrixSolutions/MatrixTrack/professinoal-punch-inside-routes/appRoute/newattedenceRoute.js';

const c1 = fs.readFileSync(file1Path, 'utf8');
const c2 = fs.readFileSync(file2Path, 'utf8');

// Compare the list of defined routes in each file
// Routes are defined using router.post, router.get, etc.
function getRoutes(content) {
  const lines = content.split('\n');
  const routes = [];
  lines.forEach((line, index) => {
    if (line.trim().startsWith('router.')) {
      routes.push({ lineNum: index + 1, content: line.trim() });
    }
  });
  return routes;
}

const routes1 = getRoutes(c1);
const routes2 = getRoutes(c2);

console.log('--- Routes in newAttendaceRoutes.js (file1) ---');
routes1.forEach(r => console.log(`${r.lineNum}: ${r.content}`));

console.log('\n--- Routes in newattedenceRoute.js (file2) ---');
routes2.forEach(r => console.log(`${r.lineNum}: ${r.content}`));
