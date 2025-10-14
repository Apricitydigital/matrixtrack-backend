require("dotenv").config();
const { Pool } = require("pg");

console.log("Testing database connection...");
console.log("DB_HOST:", process.env.DB_HOST);
console.log("DB_NAME:", process.env.DB_NAME);
console.log("DB_USER:", process.env.DB_USER);

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log("✅ Database connected successfully!");
    
    const result = await client.query('SELECT NOW()');
    console.log("✅ Query test successful:", result.rows[0]);
    
    client.release();
    process.exit(0);
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    process.exit(1);
  }
}

testConnection();
