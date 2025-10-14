require("dotenv").config();
console.log("Environment variables loaded:");
console.log("DB_USER:", process.env.DB_USER);
console.log("DB_HOST:", process.env.DB_HOST);
console.log("DB_NAME:", process.env.DB_NAME);
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "SET" : "NOT SET");
console.log("PORT:", process.env.PORT);

const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Test server is running...");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Test server running on port ${PORT}`);
});
