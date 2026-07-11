const Redis = require('ioredis');
require('dotenv').config();

const redisClient = new Redis(process.env.REDIS_URL || {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1, 
  retryStrategy(times) {
    if (times > 3) {
      console.warn('[Redis] Failed to connect after 3 attempts. Disabling Redis.');
      return null; // Stop retrying
    }
    return Math.min(times * 50, 2000);
  }
});

redisClient.on('error', (err) => {
  console.warn('[Redis] Connection error (will fall back to DB):', err.message);
});

redisClient.on('connect', () => {
  console.log('[Redis] Connected successfully.');
});

module.exports = redisClient;
