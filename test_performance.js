const axios = require('axios');

const BASE_URL = 'http://localhost:5000/api';
// Use a real supervisor ID from your system or just test the public gallery
const SUPERVISOR_ID = 11; 

async function testGalleryPerformance() {
  console.log('--- Testing Face Gallery Performance ---');
  
  const start = Date.now();
  try {
    const response = await axios.get(`${BASE_URL}/app/attendance/employee/faceRoutes/gallery?supervisor_id=${SUPERVISOR_ID}`);
    const end = Date.now();
    
    console.log(`Gallery fetch took: ${end - start}ms`);
    console.log(`Count: ${response.data.data?.length || 0}`);
    
    const firstImage = response.data.data?.[0];
    if (firstImage && firstImage.url) {
      console.log(`First image URL: ${firstImage.url}`);
      
      const imgStart = Date.now();
      try {
          const imgUrl = firstImage.url.startsWith('http') ? firstImage.url : `${BASE_URL}/${firstImage.url}`;
          console.log(`Fetching image: ${imgUrl}`);
          await axios.get(imgUrl, { headers: { Range: 'bytes=0-100' } }); // Just partial fetch
          console.log(`Image fetch took: ${Date.now() - imgStart}ms`);
      } catch (e) {
          console.error(`Image fetch failed: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`Gallery fetch failed: ${err.message}`);
    if (err.response) console.error(err.response.data);
  }
}

testGalleryPerformance();
