// config/awsConfig.js
const {
  RekognitionClient,
  IndexFacesCommand,
  CreateCollectionCommand,
  DeleteFacesCommand,
  CompareFacesCommand,
  SearchFacesByImageCommand,
  DetectFacesCommand,
} = require("@aws-sdk/client-rekognition");
const {
  S3Client,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");

// Initialize AWS clients
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Export the clients and commands
module.exports = {
  rekognition,
  s3,
  IndexFacesCommand,
  CreateCollectionCommand,
  DeleteFacesCommand,
  CompareFacesCommand,
  SearchFacesByImageCommand,
  DetectFacesCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
};
