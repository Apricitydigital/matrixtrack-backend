/**
 * API Key Utilities
 * Handles generation, hashing, and validation of external API keys.
 * Key format: mt_live_<40-char-hex> or mt_test_<40-char-hex>
 */

const crypto = require("crypto");

const KEY_PREFIX = "mt";
const KEY_LENGTH = 40; // 40 hex chars = 160 bits of entropy

/**
 * Generate a new API key.
 * @param {"live"|"test"} env - Environment type
 * @returns {{ fullKey: string, prefix: string, hash: string }}
 *   fullKey — the raw key to show to the user (once only)
 *   prefix — short identifier for display (e.g. "mt_live_a3f2b8c9")
 *   hash   — SHA-256 hex digest to store in DB
 */
const generateApiKey = (env = "live") => {
  const randomPart = crypto.randomBytes(KEY_LENGTH / 2).toString("hex"); // 40 hex chars
  const fullKey = `${KEY_PREFIX}_${env}_${randomPart}`;
  const prefix = `${KEY_PREFIX}_${env}_${randomPart.slice(0, 8)}`;
  const hash = hashApiKey(fullKey);

  return { fullKey, prefix, hash };
};

/**
 * Hash a raw API key for storage/lookup.
 * @param {string} rawKey - The full API key string
 * @returns {string} SHA-256 hex digest
 */
const hashApiKey = (rawKey) => {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
};

/**
 * Validate the format of a raw API key.
 * @param {string} rawKey
 * @returns {boolean}
 */
const isValidKeyFormat = (rawKey) => {
  if (!rawKey || typeof rawKey !== "string") return false;
  // mt_live_<40 hex chars> or mt_test_<40 hex chars>
  return /^mt_(live|test)_[a-f0-9]{40}$/.test(rawKey);
};

module.exports = {
  generateApiKey,
  hashApiKey,
  isValidKeyFormat,
};
