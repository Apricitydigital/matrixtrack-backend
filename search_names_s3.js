require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const buckets = ['attend-ease-images', 'dailyfacerecord', 'mrfimagesave', 'taskforce-multicity'];

async function searchBucket(bucket, searchTerm) {
  console.log(`Searching bucket: ${bucket} for term: ${searchTerm}`);
  let continuationToken = undefined;
  let matches = [];
  try {
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents || []) {
        if (obj.Key.toLowerCase().includes(searchTerm.toLowerCase())) {
          matches.push(obj.Key);
        }
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    
    if (matches.length > 0) {
      console.log(`  MATCHES in ${bucket}:`);
      matches.forEach(m => console.log(`    - ${m}`));
    }
  } catch (e) {
    console.log(`  Error searching ${bucket}: ${e.message}`);
  }
}

const terms = ['Ishika', 'Sunpreet'];

async function run() {
  for (const b of buckets) {
    for (const t of terms) {
      await searchBucket(b, t);
    }
  }
}

run().catch(console.error).finally(() => process.exit(0));
