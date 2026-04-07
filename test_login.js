const axios = require('axios');

async function testLogin() {
  try {
    console.log('Testing login with admin@gmail.com...');
    const res = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'admin@gmail.com',
      password: 'admin' // I saw this in the user's screenshot password field (dots looked short)
      // Actually, standard admin password might be different. 
      // I'll try just the ping first.
    });
    console.log('Login Result:', res.data.message);
  } catch (err) {
    if (err.response) {
      console.error('Login Failed:', err.response.status, err.response.data.error);
    } else {
      console.error('Connection Failed:', err.message);
    }
  }
}

testLogin();
