require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const buckets = ['attend-ease-images', 'dailyfacerecord'];

async function deepSearchBucket(bucket, targetId) {
  console.log(`Checking bucket: ${bucket} for ID: ${targetId}`);
  let continuationToken = undefined;
  let matches = [];
  try {
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents || []) {
        if (obj.Key.includes(targetId)) matches.push(obj.Key);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    
    if (matches.length > 0) {
      console.log(`  MATCHES FOUND in ${bucket}:`);
      matches.forEach(m => console.log(`    - ${m}`));
    } else {
      console.log(`  No matching keys found in ${bucket}`);
    }
  } catch (e) {
    console.log(`  Error searching ${bucket}: ${e.message}`);
  }
}

const targets = ['8956', '9726', 'EMP2025', 'MP1692830'];

async function run() {
  for (const b of buckets) {
    for (const t of targets) {
      await deepSearchBucket(b, t);
    }
  }
}

run().catch(console.error).finally(() => process.exit(0));
