const axios = require('axios');

(async () => {
  try {
    const recordsRes = await axios.post('http://localhost:5000/api/attendance?date=2026-03-23', {});
    
    console.log(`Records fetched: ${recordsRes.data.length}`);
    if (recordsRes.data.length > 0) {
      console.log('Sample record:', recordsRes.data[0]);
    } else {
      console.log('Returns Empty Array', recordsRes.data);
    }
  } catch (err) {
    console.error('API Error:', err.response?.data || err.message);
  }
})();
