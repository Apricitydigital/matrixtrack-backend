const fs = require('fs');
const path = require('path');

const file1 = path.join(__dirname, '../routes/appRoutes/newAttendaceRoutes.js');
const file2 = 'd:/HumanMatrixSolutions/MatrixTrack/professinoal-punch-inside-routes/appRoute/newattedenceRoute.js';

if (!fs.existsSync(file1)) {
  console.log('file1 does not exist:', file1);
}
if (!fs.existsSync(file2)) {
  console.log('file2 does not exist:', file2);
}

if (fs.existsSync(file1) && fs.existsSync(file2)) {
  const c1 = fs.readFileSync(file1, 'utf8');
  const c2 = fs.readFileSync(file2, 'utf8');
  console.log('file1 length:', c1.length);
  console.log('file2 length:', c2.length);

  // Check if file2 contains "/self/punch"
  console.log('file2 has self/punch:', c2.includes('/self/punch'));
  console.log('file1 has self/punch:', c1.includes('/self/punch'));
}
