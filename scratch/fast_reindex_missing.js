const { Pool } = require('pg');
const { RekognitionClient, ListFacesCommand, IndexFacesCommand } = require('@aws-sdk/client-rekognition');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
});

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials,
});

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials,
});

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
const secondaryBucketName = process.env.SECONDARY_S3_BUCKET;
const collectionId = process.env.REKOGNITION_COLLECTION || 'attendease-faces';

function resolveS3ObjectKey(reference) {
  if (!reference) return null;
  if (reference.includes("://")) {
    try {
      const url = new URL(reference);
      return decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
    } catch (error) {
      return null;
    }
  }
  return reference.replace(/^\/+/u, "");
}

async function main() {
  console.log('Fetching database face IDs...');
  const { rows: dbRows } = await pool.query(
    'SELECT emp_id, name, face_id, face_embedding FROM employee WHERE face_embedding IS NOT NULL AND face_id IS NOT NULL AND face_id <> \'\''
  );
  console.log(`Database has ${dbRows.length} employees with Face IDs.`);

  console.log('Fetching Rekognition collection face IDs...');
  const awsFaceIds = new Set();
  let nextToken = null;

  do {
    try {
      const resp = await rekognition.send(
        new ListFacesCommand({
          CollectionId: collectionId,
          MaxResults: 4096,
          NextToken: nextToken,
        })
      );
      if (resp.Faces) {
        resp.Faces.forEach(f => awsFaceIds.add(f.FaceId));
      }
      nextToken = resp.NextToken;
    } catch (err) {
      console.error('Error listing faces:', err);
      break;
    }
  } while (nextToken);

  console.log(`AWS Collection has ${awsFaceIds.size} faces.`);

  // Filter missing employees
  const missing = dbRows.filter(emp => !awsFaceIds.has(emp.face_id));
  console.log(`Found ${missing.length} employees missing from Rekognition.`);

  if (missing.length === 0) {
    console.log('No missing employees to index. All sync!');
    process.exit(0);
  }

  console.log(`Starting parallel re-indexing of ${missing.length} employees (concurrency: 15)...`);

  const concurrency = 15;
  let currentIndex = 0;
  let indexed = 0;
  let failed = 0;
  let skipped = 0;

  const next = async () => {
    if (currentIndex >= missing.length) return;
    const emp = missing[currentIndex++];

    try {
      const s3Key = resolveS3ObjectKey(emp.face_embedding);
      if (!s3Key) {
        skipped++;
        return await next();
      }

      // Verify bucket
      let activeBucket = bucketName;
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
      } catch (_e) {
        let foundInSecondary = false;
        if (secondaryBucketName) {
          try {
            await s3.send(new HeadObjectCommand({ Bucket: secondaryBucketName, Key: s3Key }));
            activeBucket = secondaryBucketName;
            foundInSecondary = true;
          } catch (_e2) {}
        }
        if (!foundInSecondary) {
          skipped++;
          return await next();
        }
      }

      // Re-index the face
      const indexResp = await rekognition.send(
        new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { S3Object: { Bucket: activeBucket, Name: s3Key } },
          ExternalImageId: emp.emp_id.toString(),
          DetectionAttributes: ["DEFAULT"],
          MaxFaces: 1,
          QualityFilter: "NONE",
        })
      );

      const newFaceRecord = indexResp.FaceRecords?.[0];
      if (newFaceRecord) {
        const newFaceId = newFaceRecord.Face.FaceId;
        const newConfidence = newFaceRecord.Face.Confidence;

        await pool.query(
          `UPDATE employee SET face_id = $1, face_confidence = $2 WHERE emp_id = $3`,
          [newFaceId, newConfidence, emp.emp_id]
        );
        indexed++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
    }

    if (currentIndex % 100 === 0) {
      console.log(`[Progress] Indexed: ${indexed}, Failed: ${failed}, Skipped: ${skipped}, Left: ${missing.length - currentIndex}`);
    }
    await next();
  };

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(next());
  }
  await Promise.all(workers);

  console.log(`\nReindexing complete:`);
  console.log(`- Successfully indexed: ${indexed}`);
  console.log(`- Failed: ${failed}`);
  console.log(`- Skipped (Image missing): ${skipped}`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
