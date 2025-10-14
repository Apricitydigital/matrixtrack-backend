require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");

// Import Routes
const authRoutes = require("./routes/authRoutes");
const allRoutes = require("./routes/index");
const appRoutes = require("./routes/appRoutes/index");

const app = express();

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://192.168.29.213:3000",
      "http://192.168.29.213:61960",
      "https://d30v7d7vnspm71.cloudfront.net", // CloudFront
      "http://attendease-frontend.s3-website.ap-south-1.amazonaws.com", // S3 frontend
      "https://c68e-2405-201-300b-8910-9562-50d3-77c0-e73d.ngrok-free.app",
      "http://192.168.29.88:8081", // React Native Metro bundler
      "http://192.168.29.88:19000", // Expo development server
      "http://10.205.83.56:8081", // React Native Metro bundler (new IP)
      "http://10.205.83.56:8082", // Expo development server (new IP)
      "http://10.205.83.56:19000", // Expo development server (new IP)
    ],
    credentials: true,
  })
);
app.use(cookieParser());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// General API Route
app.get("/", (req, res) => {
  res.send("Attendance System API is running...");
});

// Auth Routes
app.use("/api/auth", authRoutes);

// Other Routes
app.use("/api", allRoutes);

// app Routes
app.use("/api/app", appRoutes);

// Start Server
const PORT = process.env.PORT || 5002;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
