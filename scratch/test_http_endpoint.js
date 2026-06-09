const axios = require('axios');

axios.get('http://localhost:5000/api/supervisor-attendance')
  .then(res => {
    console.log("SUCCESS! Status:", res.status);
    console.log("Data:", res.data);
  })
  .catch(err => {
    console.log("ERROR! Status:", err.response ? err.response.status : "No response");
    console.log("Error details:", err.response ? err.response.data : err.message);
  });
