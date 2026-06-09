const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

async function run() {
  try {
    const token = jwt.sign(
      { user_id: 1, role: 'admin' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '1h' }
    );
    console.log('Generated Token:', token);

    const res = await axios.get('http://localhost:5000/api/supervisor-attendance', {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        startDate: '2026-06-02',
        endDate: '2026-06-02',
        cityId: '1'
      }
    });

    console.log('STATUS:', res.status);
    console.log('DATA LENGTH:', res.data.length);
  } catch (err) {
    if (err.response) {
      console.error('API ERROR RESPONSE:', err.response.status, err.response.data);
    } else {
      console.error('ERROR:', err.message);
    }
  }
}

run();
