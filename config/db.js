const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },  // Required for RDS/cloud connections

  max: 10,                             // Max DB connections
  min: 0,                              // Don't keep idle connections — avoids server-side idle kills
  connectionTimeoutMillis: 15000,      // Wait max 15s for a connection (up from 8s)
  idleTimeoutMillis: 10000,            // Release idle connections after 10s (before RDS kills them)
  statement_timeout: 15000,            // Kill queries running > 15s

  // TCP keepalive — prevents silent connection drops by routers/firewalls/RDS
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Log pool errors so they don't silently swallow connection issues
pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected error on idle client:", err.message);
});

module.exports = pool;
