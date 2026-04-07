const { HeadObjectCommand } = require('@aws-sdk/client-s3');
const { s3 } = require('./config/awsConfig');
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;

async function check() {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: 'faces/89/1762743626494_89-face-store-1762743624938.jpg' }));
    console.log("CHHAYA KEY EXISTS");
  } catch (e) {
    console.log("CHHAYA KEY MISSING: " + e.message);
  }
}
check();
