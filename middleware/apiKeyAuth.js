/**
 * API Key Authentication Middleware
 * Validates external API keys passed via `x-api-key` header.
 * Attaches `req.apiKey` with scoping info for downstream handlers.
 *
 * Flow:
 *   1. Extract x-api-key header
 *   2. SHA-256 hash → lookup in api_keys table
 *   3. Validate: active, not expired, IP whitelist
 *   4. Attach { id, scopes, cityId, rateLimit } to req.apiKey
 *   5. Async log the request
 */

const pool = require("../config/db");
const { hashApiKey } = require("../utils/apiKeyUtils");

// In-memory cache for API key lookups (TTL-based)
const keyCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

const getCachedKey = (hash) => {
  const entry = keyCache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    keyCache.delete(hash);
    return null;
  }
  return entry.data;
};

const setCachedKey = (hash, data) => {
  keyCache.set(hash, { data, cachedAt: Date.now() });
};

/**
 * Invalidate the cache for a specific key hash or all keys.
 * @param {string|null} hash - Key hash to invalidate, or null for all
 */
const invalidateApiKeyCache = (hash = null) => {
  if (hash) {
    keyCache.delete(hash);
  } else {
    keyCache.clear();
  }
};

/**
 * Log API key usage asynchronously (fire-and-forget).
 */
const logUsage = (apiKeyId, endpoint, method, status, ip, userAgent) => {
  pool
    .query(
      `INSERT INTO api_key_usage_logs (api_key_id, endpoint, method, response_status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5::inet, $6)`,
      [apiKeyId, endpoint, method, status, ip || null, userAgent || null]
    )
    .catch((err) => {
      console.error("[ApiKeyAuth] Usage log error:", err.message);
    });
};

/**
 * Update last_used_at and increment total_requests (fire-and-forget).
 */
const updateKeyStats = (apiKeyId) => {
  pool
    .query(
      `UPDATE api_keys SET last_used_at = NOW(), total_requests = total_requests + 1 WHERE id = $1`,
      [apiKeyId]
    )
    .catch((err) => {
      console.error("[ApiKeyAuth] Stats update error:", err.message);
    });
};

/**
 * Express middleware: authenticate via x-api-key header.
 */
const apiKeyAuth = async (req, res, next) => {
  const rawKey = req.header("x-api-key");

  if (!rawKey) {
    return res.status(401).json({
      success: false,
      error: {
        code: "MISSING_API_KEY",
        message: "Missing x-api-key header. Include your API key in the request.",
      },
    });
  }

  try {
    const keyHash = hashApiKey(rawKey);

    // Try cache first
    let keyRow = getCachedKey(keyHash);

    if (!keyRow) {
      const result = await pool.query(
        `SELECT id, key_prefix, name, city_id, zone_id, ward_id, scopes, is_active,
                rate_limit_per_minute, allowed_ips, expires_at
         FROM api_keys
         WHERE key_hash = $1`,
        [keyHash]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: {
            code: "INVALID_API_KEY",
            message: "Invalid API key. Check your key and try again.",
          },
        });
      }

      keyRow = result.rows[0];
      setCachedKey(keyHash, keyRow);
    }

    // Check if key is active
    if (!keyRow.is_active) {
      return res.status(403).json({
        success: false,
        error: {
          code: "API_KEY_REVOKED",
          message: "This API key has been revoked. Contact your administrator.",
        },
      });
    }

    // Check expiration
    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.status(403).json({
        success: false,
        error: {
          code: "API_KEY_EXPIRED",
          message: "This API key has expired. Request a new key from your administrator.",
        },
      });
    }

    // Check IP whitelist
    if (keyRow.allowed_ips && keyRow.allowed_ips.length > 0) {
      const clientIp =
        req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
        req.socket?.remoteAddress ||
        "";
      // Normalize IPv6-mapped IPv4 addresses
      const normalizedIp = clientIp.replace(/^::ffff:/, "");
      if (!keyRow.allowed_ips.includes(normalizedIp) && !keyRow.allowed_ips.includes(clientIp)) {
        return res.status(403).json({
          success: false,
          error: {
            code: "IP_NOT_ALLOWED",
            message: "Your IP address is not authorized for this API key.",
          },
        });
      }
    }

    // Attach key info to request
    req.apiKey = {
      id: keyRow.id,
      prefix: keyRow.key_prefix,
      name: keyRow.name,
      cityId: keyRow.city_id,
      zoneId: keyRow.zone_id,
      wardId: keyRow.ward_id,
      scopes: keyRow.scopes || ["attendance:read"],
      rateLimit: keyRow.rate_limit_per_minute || 100,
    };

    // Fire-and-forget: update stats
    updateKeyStats(keyRow.id);

    // Hook into response finish to log usage with status code
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "";
    const userAgent = req.headers["user-agent"] || "";

    res.on("finish", () => {
      logUsage(keyRow.id, req.originalUrl, req.method, res.statusCode, clientIp, userAgent);
    });

    next();
  } catch (error) {
    console.error("[ApiKeyAuth] Middleware error:", error.message);
    return res.status(500).json({
      success: false,
      error: {
        code: "AUTH_ERROR",
        message: "Internal authentication error. Please try again.",
      },
    });
  }
};

/**
 * Scope-checking middleware factory.
 * @param {string} requiredScope - e.g. "attendance:read"
 */
const requireScope = (requiredScope) => {
  return (req, res, next) => {
    if (!req.apiKey) {
      return res.status(401).json({
        success: false,
        error: { code: "NO_AUTH", message: "Authentication required." },
      });
    }

    const scopes = req.apiKey.scopes || [];
    if (!scopes.includes(requiredScope)) {
      return res.status(403).json({
        success: false,
        error: {
          code: "INSUFFICIENT_SCOPE",
          message: `This API key does not have the '${requiredScope}' permission.`,
        },
      });
    }

    next();
  };
};

module.exports = {
  apiKeyAuth,
  requireScope,
  invalidateApiKeyCache,
};
