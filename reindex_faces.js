require("dotenv").config();
const { 
  rekognition, 
  s3, 
  IndexFacesCommand, 
  DeleteFacesCommand, 
  HeadObjectCommand,
  ListObjectsV2Command
} = require("./config/awsConfig");
const pool = require("./config/db");
const { parseFaceKey } = require("./utils/faceImage");

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
const secondaryBucketName = process.env.SECONDARY_S3_BUCKET || null;
const collectionId = (process.env.REKOGNITION_COLLECTION || "").trim();

async function run() {
  if (!collectionId) {
    console.error("REKOGNITION_COLLECTION is not set in .env");
    process.exit(1);
  }

  console.log(`Starting bulk re-index into collection: ${collectionId}`);
  
  const { rows } = await pool.query(
    "SELECT emp_id, emp_code, face_embedding, face_id FROM employee WHERE face_embedding IS NOT NULL"
  );

  console.log(`Found ${rows.length} employees with face_embedding records.`);

  let indexed = 0;
  let healed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    let s3Key = parseFaceKey(row.face_embedding);
    let activeBucket = bucketName;
    let needsHeal = false;

    // 1. Verify if the direct key exists
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
    } catch (_e) {
      if (secondaryBucketName) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: secondaryBucketName, Key: s3Key }));
          activeBucket = secondaryBucketName;
        } catch (_e2) {
          needsHeal = true;
        }
      } else {
        needsHeal = true;
      }
    }

    // 2. 🛡️ Self-Healing: Search by prefix if the direct key is broken
    if (needsHeal) {
      const candidatePrefixes = [
        `faces/${row.emp_id}/`,
        row.emp_code ? `faces/${row.emp_code}/` : null,
        `${row.emp_id}/`,
        row.emp_code ? `${row.emp_code}/` : null,
      ].filter(Boolean);

      const buckets = [bucketName, secondaryBucketName].filter(Boolean);
      let foundHeal = false;

      for (const bucket of buckets) {
        for (const prefix of candidatePrefixes) {
          try {
            const listResp = await s3.send(new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              MaxKeys: 1,
            }));
            const foundKey = listResp?.Contents?.[0]?.Key;
            if (foundKey) {
              s3Key = foundKey;
              activeBucket = bucket;
              foundHeal = true;
              healed++;
              
              // Backfill the corrected key into the database
              await pool.query("UPDATE employee SET face_embedding = $1 WHERE emp_id = $2", [s3Key, row.emp_id]);
              break;
            }
          } catch (_err) {}
        }
        if (foundHeal) break;
      }

      if (!foundHeal) {
        console.warn(`[NOT_FOUND] emp_id=${row.emp_id}: No valid S3 file found in any prefix.`);
        skipped++;
        continue;
      }
    }

    // 3. Index the face into Rekognition
    try {
      // Remove old face_id from collection to avoid duplicates
      if (row.face_id) {
        try {
          await rekognition.send(
            new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: [row.face_id] })
          );
        } catch (_del) {}
      }

      // Download the image ourselves and pass as Bytes.
      // Using S3Object directly in IndexFacesCommand can fail with
      // "Unable to get object" when Rekognition's service role doesn't
      // have cross-bucket access. Bytes always works via our own SDK creds.
      const { GetObjectCommand } = require("./config/awsConfig");
      const s3Resp = await s3.send(new GetObjectCommand({ Bucket: activeBucket, Key: s3Key }));
      const chunks = [];
      for await (const chunk of s3Resp.Body) chunks.push(chunk);
      const imageBytes = Buffer.concat(chunks);

      const indexResp = await rekognition.send(
        new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { Bytes: imageBytes },
          ExternalImageId: row.emp_id.toString(),
          DetectionAttributes: ["DEFAULT"],
          MaxFaces: 1,
          QualityFilter: "NONE",
        })
      );

      const newFaceRecord = indexResp.FaceRecords?.[0];
      if (!newFaceRecord) {
        console.warn(`[UNINDEXABLE] No face detected for emp_id=${row.emp_id} (key: ${s3Key})`);
        failed++;
        continue;
      }

      const newFaceId = newFaceRecord.Face.FaceId;
      const newConfidence = newFaceRecord.Face.Confidence;

      await pool.query(
        "UPDATE employee SET face_id = $1, face_confidence = $2 WHERE emp_id = $3",
        [newFaceId, newConfidence, row.emp_id]
      );

      indexed++;
      if (indexed % 100 === 0) {
        console.log(`Progress: Total=${rows.length}, Indexed=${indexed}, Healed=${healed}, Skipped=${skipped}, Failed=${failed}`);
      }
    } catch (err) {
      console.error(`[ERR] emp_id=${row.emp_id} (Key: ${s3Key}): ${err.message}`);
      failed++;
    }
  }

  console.log(`\nRe-index Complete!`);
  console.log(`Summary: Total=${rows.length}, Indexed=${indexed}, Healed=${healed}, Skipped=${skipped}, Failed=${failed}`);
  
  process.exit(0);
}

run().catch(e => {
  console.error("Fatal Script Error:", e);
  process.exit(1);
});
