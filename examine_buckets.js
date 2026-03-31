require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const buckets = [
  'app.matrixtrack.in',
  'attend-ease-images',
  'attendease-frontend',
  'dailyfacerecord',
  'matrixtrackfrontend',
  'mrfimagesave',
  'taskforce-multicity'
];

async function examine(bucket) {
  console.log(`\n--- Bucket: ${bucket} ---`);
  try {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      MaxKeys: 50
    }));
    if (!resp.Contents || resp.Contents.length === 0) {
      console.log('  Empty bucket');
      return;
    }
    resp.Contents.forEach(obj => console.log(`  - ${obj.Key}`));
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
}

async function run() {
  for (const b of buckets) {
    await examine(b);
  }
}

run().catch(console.error).finally(() => process.exit(0));
