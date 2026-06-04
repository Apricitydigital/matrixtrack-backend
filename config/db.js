const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }, // Required for RDS connections
  max: 10,                            // Max DB connections (prevents RDS exhaustion)
  min: 2,                             // Keep a minimum of 2 connections alive
  connectionTimeoutMillis: 15000,     // Wait max 15s for a free connection
  idleTimeoutMillis: 30000,           // Close idle connections after 30s
  // IMPORTANT: Some dashboard queries can exceed 60s on RDS; allow more time without changing logic/data.
  statement_timeout: 180000,          // Cancel any query running > 3 minutes
});

module.exports = pool;
