const fs = require('fs');
const content = fs.readFileSync('routes/appRoutes/supervisorsWard.js', 'utf8');
const lines = content.split('\n');
console.log('Total lines:', lines.length);
console.log('Line 1:', lines[0]);
console.log('Line 2:', lines[1]);
console.log('Has router:', content.includes('router'));
console.log('Has router.post:', content.includes('router.post'));
