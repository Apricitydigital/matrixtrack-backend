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

const s3Bucket = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;

async function deepSearch(targetId) {
  console.log(`Searching for ID: ${targetId} in S3 bucket: ${s3Bucket}`);
  let continuationToken = undefined;
  let matches = [];
  let totalScanned = 0;

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: s3Bucket,
      ContinuationToken: continuationToken,
    }));
    
    const contents = resp.Contents || [];
    totalScanned += contents.length;
    
    for (const obj of contents) {
      if (obj.Key.includes(targetId)) {
        matches.push(obj.Key);
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    process.stdout.write(`\rScanned ${totalScanned} objects...`);
  } while (continuationToken);

  console.log(`\nFound ${matches.length} matches for ${targetId}:`);
  matches.forEach(m => console.log(` - ${m}`));
  return matches;
}

const targets = ['8956', '9726'];

async function run() {
  for (const t of targets) {
    await deepSearch(t);
  }
}

run().catch(console.error).finally(() => process.exit(0));
