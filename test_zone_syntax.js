const axios = require('axios');

const test = async () => {
  const apiUrl = 'http://localhost:5000/api'; // Assuming backend is on 5000
  const token = 'REPLACE_WITH_VALID_TOKEN'; // I don't have a token, I'll use a local bypass or just run the logic locally
  
  // Actually, I'll just run the logic from zoneRoutes locally in a script
  const pool = require('./config/db');
  
  const mockReq = {
    cityScope: { all: true, ids: [] },
    kothiScope: { all: false, ids: [1, 2, 3] }, // Example kothis
    query: { cityId: '12' }
  };
  
  const scope = mockReq.cityScope;
  const kothiScope = mockReq.kothiScope;
  const params = [];
  let whereClause = "";

  if (!scope.all) {
    params.push(scope.ids);
    whereClause = 'WHERE c.city_id = ANY($' + params.length + ')';
  }

  if (mockReq.query.cityId) {
    const ids = String(mockReq.query.cityId)
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id));
    if (ids.length > 0) {
      params.push(ids);
      whereClause += whereClause ? ' AND c.city_id = ANY($' + params.length + ')' : 'WHERE c.city_id = ANY($' + params.length + ')';
    }
  }

  if (!kothiScope.all && kothiScope.ids.length > 0) {
    params.push(kothiScope.ids);
    whereClause += whereClause 
      ? ' AND z.zone_id IN (SELECT DISTINCT zone_id FROM wards WHERE ward_id = ANY($' + params.length + '))' 
      : 'WHERE z.zone_id IN (SELECT DISTINCT zone_id FROM wards WHERE ward_id = ANY($' + params.length + '))';
  }

  const query = `
    SELECT z.zone_id, z.zone_name, c.city_id, c.city_name
    FROM zones z
    JOIN cities c ON z.city_id = c.city_id
    ${whereClause}
    ORDER BY z.zone_id ASC
  `;
  
  console.log('Generated Query:', query);
  console.log('Params:', params);
  
  try {
    const result = await pool.query(query, params);
    console.log('Result Count:', result.rowCount);
    console.log('Success!');
  } catch (err) {
    console.error('Query Failed:', err);
  } finally {
    process.exit(0);
  }
};

test();
