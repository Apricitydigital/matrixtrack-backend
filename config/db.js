const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }, // Required for RDS connections
  connectionTimeoutMillis: 5000, // Fail fast if can't connect
  idleTimeoutMillis: 30000, // Close idle connections
});

module.exports = pool;
