require("dotenv").config();
const { rekognition, CreateCollectionCommand, IndexFacesCommand } = require("./config/awsConfig");
const pool = require("./config/db");
const { parseFaceKey } = require("./utils/faceImage");

const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
const collectionId = (process.env.REKOGNITION_COLLECTION || process.env.REKOGNITION_COLLECTION_ID || "employee").trim();
const MAX_FACES = 1;
const BATCH_LOG = 500;
const BATCH_SIZE = Number(process.env.REINDEX_BATCH_SIZE || 2000);

if (!bucket) {
  console.error("AWS_S3_BUCKET is not set");
  process.exit(1);
}

(async () => {
  try {
    await rekognition.send(new CreateCollectionCommand({ CollectionId: collectionId }));
  } catch (err) {
    if (err.name !== "ResourceAlreadyExistsException") {
      console.error("Create collection failed:", err.message);
      process.exit(1);
    }
  }

  let offset = 0;
  let indexed = 0;
  let failed = 0;
  let total = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT emp_id, face_embedding
         FROM employee
        WHERE face_embedding IS NOT NULL
        ORDER BY emp_id
        LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );
    if (!rows.length) break;
    total += rows.length;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = parseFaceKey(row.face_embedding);
      if (!key) {
        failed++;
        continue;
      }

      try {
        await rekognition.send(
          new IndexFacesCommand({
            CollectionId: collectionId,
            ExternalImageId: String(row.emp_id),
            Image: { S3Object: { Bucket: bucket, Name: key } },
            MaxFaces: MAX_FACES,
            QualityFilter: "HIGH",
          })
        );
        indexed++;
      } catch (err) {
        failed++;
        console.error(`Index fail emp ${row.emp_id}:`, err.message);
      }

      const globalIndex = offset + i + 1;
      if (globalIndex % BATCH_LOG === 0) {
        console.log(`Progress: ${globalIndex} (indexed: ${indexed}, failed: ${failed})`);
      }
    }

    offset += BATCH_SIZE;
  }

  console.log({ total, indexed, failed });
  await pool.end();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
