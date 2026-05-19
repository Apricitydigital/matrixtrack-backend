const pool = require('../config/db');
const redisClient = require('../config/redis');

const CACHE_TTL_SECONDS = 10 * 60; // 10 minutes

const parseDropdownId = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

/**
 * Helper function to fetch data from Redis cache or database fallback.
 * @param {string} cacheKey - The Redis cache key
 * @param {Function} dbFetchFunction - Async function returning the data from DB
 * @returns {Promise<any>} - The cached or freshly fetched data
 */
async function fetchWithCache(cacheKey, dbFetchFunction) {
  try {
    if (redisClient.status === 'ready') {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch (err) {
    console.warn(`[Redis] Cache read error for ${cacheKey}:`, err.message);
  }

  // Fallback to database
  const data = await dbFetchFunction();

  // Set Cache
  try {
    if (redisClient.status === 'ready' && data) {
      await redisClient.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL_SECONDS);
    }
  } catch (err) {
    console.warn(`[Redis] Cache write error for ${cacheKey}:`, err.message);
  }

  return data;
}

/**
 * @desc    Get all cities
 * @route   GET /api/public/cities
 * @access  Public
 */
const getCities = async (req, res) => {
  try {
    const cacheKey = "dropdown:cities";
    
    const data = await fetchWithCache(cacheKey, async () => {
      const result = await pool.query(`
        SELECT city_id, city_name 
        FROM cities 
        ORDER BY city_name ASC
      `);
      return result.rows;
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching cities:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * @desc    Get zones for a given city
 * @route   GET /api/public/zones?city_id=12
 * @access  Public
 */
const getZones = async (req, res) => {
  try {
    const { city_id } = req.query;
    
    if (!city_id) {
      return res.status(400).json({ success: false, message: 'city_id query parameter is required' });
    }

    const cacheKey = `dropdown:zones:${city_id}`;
    
    const data = await fetchWithCache(cacheKey, async () => {
      const result = await pool.query(`
        SELECT zone_id, zone_name 
        FROM zones 
        WHERE city_id = $1 
        ORDER BY zone_name ASC
      `, [city_id]);
      return result.rows;
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching zones:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * @desc    Get wards (sectors in DB) for a given zone
 * @route   GET /api/public/wards?zone_id=5
 * @access  Public
 */
const getWards = async (req, res) => {
  try {
    const { zone_id } = req.query;
    
    if (!zone_id) {
      return res.status(400).json({ success: false, message: 'zone_id query parameter is required' });
    }

    const cacheKey = `dropdown:wards:${zone_id}`;
    
    // UI "Wards" map to DB "sectors"
    const data = await fetchWithCache(cacheKey, async () => {
      const result = await pool.query(`
        SELECT sector_id AS ward_id, sector_name AS ward_name 
        FROM sectors 
        WHERE zone_id = $1 
        ORDER BY sector_name ASC
      `, [zone_id]);
      return result.rows;
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching wards:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * @desc    Get kothis (wards in DB) for a given ward (sector in DB)
 * @route   GET /api/public/kothis?ward_id=10
 * @access  Public
 */
const getKothis = async (req, res) => {
  try {
    const wardId = parseDropdownId(
      req.query.ward_id,
      req.query.wardId,
      req.query.sector_id,
      req.query.sectorId
    );
    
    if (!wardId) {
      return res.status(400).json({ success: false, message: 'ward_id query parameter is required' });
    }

    const cacheKey = `dropdown:kothis:${wardId}`;
    
    // UI "Kothis" map to DB "wards"
    const data = await fetchWithCache(cacheKey, async () => {
      const result = await pool.query(`
        SELECT ward_id AS kothi_id, ward_name AS kothi_name 
        FROM wards 
        WHERE sector_id = $1 
        ORDER BY ward_name ASC
      `, [wardId]);
      return result.rows;
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching kothis:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getCities,
  getZones,
  getWards,
  getKothis
};
