const pool = require('../config/db');
const logger = require('./logger');

/**
 * Runs a query with a strict 5-second timeout and logs slow queries (>1s).
 * @param {string} text - The SQL query text.
 * @param {Array} values - The query parameters.
 * @returns {Promise<Object>} - The PostgreSQL result object.
 */
async function runQueryWithTimeout(text, values = []) {
  const queryConfig = {
    text,
    values,
    query_timeout: 5000 // 5 seconds timeout enforced natively by node-postgres
  };

  const start = performance.now();
  
  try {
    const result = await pool.query(queryConfig);
    const duration = performance.now() - start;

    if (duration > 1000) {
      logger.warn(`[SlowQuery] Execution took ${duration.toFixed(2)}ms. Query: ${text.substring(0, 200)}...`);
    }

    return result;
  } catch (error) {
    const duration = performance.now() - start;
    if (error.message.includes('timeout')) {
      logger.error(`[QueryTimeout] Query timed out after ${duration.toFixed(2)}ms. Query: ${text.substring(0, 200)}...`);
    }
    throw error;
  }
}

module.exports = {
  runQueryWithTimeout
};
