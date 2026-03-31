require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { fetchBackblazeStream } = require('./utils/backblaze');

const FALLBACK_BUCKET_NAME = process.env.B2_BUCKET_NAME;

const keys = [
  'faces/8956/1768998115456_8956-face-store-1768998115067.jpg',
  'faces/9726/1774512229039_9726-face-store-1774512228737.jpg'
];

async function checkB2() {
  console.log('Checking bucket:', FALLBACK_BUCKET_NAME);
  for (const key of keys) {
    try {
      const result = await fetchBackblazeStream(FALLBACK_BUCKET_NAME, key);
      console.log(`FOUND IN B2: ${key} (contentType: ${result.contentType})`);
    } catch (e) {
      console.error(`MISSING IN B2: ${key} (${e.message})`);
    }
  }
}

checkB2().catch(console.error).finally(() => process.exit(0));
