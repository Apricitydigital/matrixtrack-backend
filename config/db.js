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
  connectionTimeoutMillis: 8000,      // Wait max 8s for a free connection
  idleTimeoutMillis: 30000,           // Close idle connections after 30s
  statement_timeout: 15000,           // Kill any query running > 15s
});

module.exports = pool;
