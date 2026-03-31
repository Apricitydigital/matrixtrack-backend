const axios = require('axios');

async function verify() {
  const baseURL = 'http://localhost:5000/api/app/attendance/employee/faceRoutes';
  
  // Ishika (in dailyfacerecord)
  const ishikaId = '8956';
  const ishikaKey = 'faces/8956/1768998115456_8956-face-store-1768998115067.jpg';
  
  // Neeraj (in attend-ease-images)
  const neerajId = '8958';
  const neerajKey = 'faces/8958/1774935788881_8958-face-store-1774935775258.jpg';

  try {
    const ishikaResp = await axios.get(`${baseURL}/image/${ishikaId}?key=${encodeURIComponent(ishikaKey)}`);
    console.log('ISHIKA (dailyfacerecord): SUCCESS (status:', ishikaResp.status, ')');
  } catch (e) {
    console.error('ISHIKA (dailyfacerecord): FAILED (', e.response?.status || e.message, ')');
  }

  try {
    const neerajResp = await axios.get(`${baseURL}/image/${neerajId}?key=${encodeURIComponent(neerajKey)}`);
    console.log('NEERAJ (attend-ease-images): SUCCESS (status:', neerajResp.status, ')');
  } catch (e) {
    console.error('NEERAJ (attend-ease-images): FAILED (', e.response?.status || e.message, ')');
  }
}

verify().catch(console.error).finally(() => process.exit(0));
