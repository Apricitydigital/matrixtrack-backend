const pool = require('./config/db');
const { fetchCitiesFromAssignments } = require('./utils/userCityAccess');

const test = async () => {
  const userId = 1086; // Ashu
  console.log(`Testing City Access for user ${userId}...`);
  try {
    const cityAccess = await fetchCitiesFromAssignments(userId, true);
    console.log('City Access Result:', JSON.stringify(cityAccess, null, 2));
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    process.exit(0);
  }
};

test();
