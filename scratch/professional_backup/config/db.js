const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 30),
  min: Number(process.env.DB_POOL_MIN || 2),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 30000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 10000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30000),
  query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 30000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

module.exports = pool;
