require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

// Middleware
app.use(express.json());
app.use(cors({
  origin: ["http://localhost:3000"],
  credentials: true,
}));

// Test route
app.get("/", (req, res) => {
  res.json({ message: "Backend is running!", port: process.env.PORT || 5003 });
});

// Test auth route
app.post("/api/auth/login", (req, res) => {
  console.log("Login attempt:", req.body);
  res.json({ 
    message: "Test login endpoint", 
    token: "test-token",
    user: { name: "Test User", email: "test@test.com" }
  });
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Simple server running on port ${PORT}`);
  console.log(`Test it: curl http://localhost:${PORT}/`);
});
