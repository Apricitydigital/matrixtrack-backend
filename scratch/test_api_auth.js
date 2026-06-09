const axios = require('axios');
const jwt = require('jsonwebtoken');

const secret = 'ankit';
const token = jwt.sign(
  { user_id: 1, role: 'admin' },
  secret,
  { expiresIn: '45d' }
);

const attendanceUrl = 'http://localhost:5000/api/supervisor-attendance';

async function test() {
  try {
    const attendanceRes = await axios.get(attendanceUrl, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        startDate: '2026-05-01',
        endDate: '2026-06-06',
        cityId: '12' // Pune city_id
      }
    });

    console.log("API CALL SUCCESS! Status:", attendanceRes.status);
    console.log("Record count:", attendanceRes.data.length);
  } catch (err) {
    console.log("API CALL FAILED!");
    console.log("Status:", err.response ? err.response.status : "No response");
    console.log("Response data:", err.response ? err.response.data : err.message);
  }
}

test();
