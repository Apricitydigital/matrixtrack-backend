const axios = require("axios");
const jwt = require("jsonwebtoken");

async function testApi() {
  try {
    console.log("=== Testing running API locally ===");
    
    // Generate valid admin token
    // JWT secret from .env is 'ankit'
    const payload = {
      id: 1, // dummy admin ID
      role: "admin",
      cityScope: { all: true, ids: [] }
    };
    const token = jwt.sign(payload, "ankit", { expiresIn: "1h" });
    
    const url = "http://localhost:5000/api/supervisor-attendance";
    const params = {
      startDate: "2026-06-06",
      endDate: "2026-06-06",
      cityId: 1,
      zoneId: 55,
      sectorId: 37,
      wardId: 1008
    };

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params
    });

    console.log("\nAPI Response status:", response.status);
    console.log("API Response data length:", response.data ? response.data.length : 0);
    if (response.data && response.data.length > 0) {
      console.log("\nFirst item in response:", response.data[0]);
    } else {
      console.log("Response data was empty.");
    }
  } catch (err) {
    console.error("API Call error:", err.message);
    if (err.response) {
      console.error("Response error data:", err.response.data);
    }
  }
}

testApi();
