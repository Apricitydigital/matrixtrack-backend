const fs = require('fs');
const path = require('path');

const file1Path = path.join(__dirname, '../routes/appRoutes/newAttendaceRoutes.js');
const file2Path = 'd:/HumanMatrixSolutions/MatrixTrack/professinoal-punch-inside-routes/appRoute/newattedenceRoute.js';

const c1 = fs.readFileSync(file1Path, 'utf8');
const c2 = fs.readFileSync(file2Path, 'utf8');

// We can split both contents by route names and check the length of each section
const routes = [
  'router.post("/",',
  'router.put("/",',
  'router.get("/image",',
  'router.post("/face-attendance",',
  'router.post("/face-liveness",',
  'router.get("/self/status",',
  'router.get("/self/calendar",',
  'router.post("/self/onboard",',
  'router.post("/self/disable",',
  'router.post("/self/punch",',
  'router.post("/mark-leave",',
  'router.post("/unmark-leave",',
  'module.exports'
];

console.log('Comparing sections...');
for (let i = 0; i < routes.length - 1; i++) {
  const r1 = routes[i];
  const r2 = routes[i+1];
  
  const idx1_start = c1.indexOf(r1);
  const idx1_end = c1.indexOf(r2);
  const section1 = idx1_start !== -1 && idx1_end !== -1 ? c1.substring(idx1_start, idx1_end) : '';

  const idx2_start = c2.indexOf(r1);
  const idx2_end = c2.indexOf(r2);
  const section2 = idx2_start !== -1 && idx2_end !== -1 ? c2.substring(idx2_start, idx2_end) : '';

  console.log(`Route section ${r1} -> ${r2}:`);
  console.log(`  file1 length: ${section1.length}`);
  console.log(`  file2 length: ${section2.length}`);
  if (section1.length !== section2.length) {
    console.log(`  DIFFERENT! Diff in characters: ${section1.length - section2.length}`);
  }
}
