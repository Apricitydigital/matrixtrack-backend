require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');
const fs = require('fs');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const buckets = ['dailyfacerecord', 'attend-ease-images', 'attend-ease-prod']; // Adding more guesses

async function deepSearchBucket(bucket, targetId) {
  console.log(`Searching bucket: ${bucket} for ID: ${targetId}`);
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
    console.log(`  Found ${matches.length} matches in ${bucket}`);
    matches.forEach(m => console.log(`    - ${m}`));
  } catch (e) {
    console.log(`  Error searching ${bucket}: ${e.message}`);
  }
}

const targets = ['8956', '9726'];

async function run() {
  for (const b of buckets) {
    for (const t of targets) {
      await deepSearchBucket(b, t);
    }
  }
}

run().catch(console.error).finally(() => process.exit(0));
