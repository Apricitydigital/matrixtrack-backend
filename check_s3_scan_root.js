require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { s3 } = require('./config/awsConfig');
const fs = require('fs');

const bucketName = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;

async function scanS3Root() {
  let out = `Scanning root of bucket: ${bucketName}\n`;
  let continuationToken = undefined;
  
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));
    
    for (const obj of resp.Contents || []) {
      const key = obj.Key;
      if (key.includes('8956') || key.includes('9890') || key.includes('9726') || key.includes('8958') || 
          key.includes('EMP2025') || key.includes('EMP2996') || key.includes('MP1692830') || key.includes('EMP2020')) {
        out += `FOUND: ${key}\n`;
      }
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  fs.writeFileSync('db_out5.txt', out, 'utf8');
}

scanS3Root().catch(console.error).finally(() => process.exit(0));
