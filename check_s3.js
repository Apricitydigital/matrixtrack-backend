const { HeadObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./config/awsConfig');
require('dotenv').config();
const fs = require('fs');

const bucketName = process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET;

const keys = [
  'faces/8956/1768998115456_8956-face-store-1768998115067.jpg',
  'faces/9890/1774512101983_9890-face-store-1774512101655.jpg',
  'faces/9726/1774512229039_9726-face-store-1774512228737.jpg',
  'faces/8958/1774935788881_8958-face-store-1774935775258.jpg',
];

async function checkS3() {
  let out = `Checking bucket: ${bucketName}\n`;
  for (const key of keys) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
      out += `EXISTS: ${key}\n`;
    } catch (e) {
      out += `MISSING: ${key} (${e.name})\n`;
    }
  }
  fs.writeFileSync('db_out3.txt', out, 'utf8');
}

checkS3().catch(console.error).finally(() => process.exit(0));
