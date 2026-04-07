require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { ListObjectsV2Command, S3Client } = require('@aws-sdk/client-s3');
const axios = require('axios');
const fs = require('fs');

// Backblaze Auth
const B2_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
const B2_APP_KEY = process.env.B2_APPLICATION_KEY;
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || 'AttendanceImages';

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const s3Bucket = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;

async function searchB2(targetId) {
  try {
    const authHeader = Buffer.from(`${B2_KEY_ID}:${B2_APP_KEY}`).toString('base64');
    const authResp = await axios.get('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      headers: { Authorization: `Basic ${authHeader}` }
    });
    const { apiUrl, authorizationToken } = authResp.data;

    let startFileName = null;
    let matches = [];
    console.log(`Searching B2 for: ${targetId}`);

    do {
      const resp = await axios.post(`${apiUrl}/b2api/v2/b2_list_file_names`, {
        bucketId: B2_BUCKET_ID,
        startFileName,
        maxFileCount: 1000
      }, {
        headers: { Authorization: authorizationToken }
      });

      const files = resp.data.files || [];
      for (const f of files) {
        if (f.fileName.includes(targetId)) {
          matches.push(f.fileName);
        }
      }
      startFileName = resp.data.nextFileName;
    } while (startFileName);

    console.log(`B2 matches for ${targetId}:`, matches);
    return matches;
  } catch (e) {
    console.error('B2 search error:', e.message);
    return [];
  }
}

async function searchS3(targetId) {
  let matches = [];
  let continuationToken = undefined;
  console.log(`Searching S3 for: ${targetId}`);
  try {
    do {
      const resp = await s3Client.send(new ListObjectsV2Command({
        Bucket: s3Bucket,
        ContinuationToken: continuationToken,
      }));
      for (const obj of resp.Contents || []) {
        if (obj.Key.includes(targetId)) matches.push(obj.Key);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    console.log(`S3 matches for ${targetId}:`, matches);
    return matches;
  } catch (e) {
    console.error('S3 search error:', e.message);
    return [];
  }
}

const targets = ['8956', '9726', 'EMP2025', 'MP1692830'];

async function main() {
  for (const t of targets) {
    await searchS3(t);
    await searchB2(t);
  }
}

main().catch(console.error).finally(() => process.exit(0));
