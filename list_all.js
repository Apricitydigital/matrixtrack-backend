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

const bucketName = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;

async function scanS3Root() {
  let out = [];
  let continuationToken = undefined;
  
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    
    for (const obj of resp.Contents || []) {
      out.push(obj.Key);
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  fs.writeFileSync('all_s3_keys.txt', out.join('\n'), 'utf8');
}

scanS3Root().catch(console.error).finally(() => process.exit(0));
