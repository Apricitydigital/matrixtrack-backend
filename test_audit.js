const axios = require('axios');

async function testAuditAPI() {
  const url = 'http://localhost:5000/api/supervisor-audit';
  try {
    const response = await axios.get(url);
    console.log('Status:', response.status);
    console.log('Data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    if (error.response) {
      console.log('Status:', error.response.status);
      console.log('Data:', error.response.data);
    } else {
      console.log('Error (Backend might not be running):', error.message);
    }
  }
}

testAuditAPI();
