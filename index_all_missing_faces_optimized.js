 bhrequire("dotenv").config();
const { RekognitionClient, ListFacesCommand, IndexFacesCommand } = require("@aws-sdk/client-rekognition");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Client } = require("pg");
const { parseFaceKey } = require("./utils/faceImage");

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
const collectionId = (process.env.REKOGNITION_COLLECTION || process.env.REKOGNITION_COLLECTION_ID || "employee").trim();

const CONCURRENCY = 15; // 15 parallel requests (safe under AWS TPS limit)
const BATCH_UPDATE_SIZE = 100; // Update DB in batches of 100

function getDbClient() {
  return new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
  });
}

async function run() {
  console.log("=== STARTING HIGHLY OPTIMIZED INDEXING OF ALL MISSING EMPLOYEES ===");
  
  // 1. Fetch AWS faces
  const enrolledEmpIdsInCollection = new Set();
  try {
    console.log(`Step 1: Listing all faces in Rekognition collection: "${collectionId}"`);
    let nextToken = undefined;
    do {
      const command = new ListFacesCommand({
        CollectionId: collectionId,
        MaxResults: 1000,
        NextToken: nextToken
      });
      const response = await rekognition.send(command);
      (response.Faces || []).forEach(face => {
        if (face.ExternalImageId) {
          enrolledEmpIdsInCollection.add(String(face.ExternalImageId));
        }
      });
      nextToken = response.NextToken;
    } while (nextToken);
    console.log(`Found ${enrolledEmpIdsInCollection.size} unique employees already in collection.`);
  } catch (err) {
    console.error("Failed to list collection faces:", err);
    process.exit(1);
  }

  // 2. Query DB and close immediately
  let dbRows = [];
  const client = getDbClient();
  try {
    console.log("Step 2: Connecting to DB to fetch employees...");
    await client.connect();
    const { rows } = await client.query(
      "SELECT emp_id, emp_code, face_embedding, name FROM employee WHERE face_embedding IS NOT NULL"
    );
    dbRows = rows;
    console.log(`Found ${dbRows.length} employees with face_embeddings in DB.`);
  } catch (err) {
    console.error("Failed to fetch employees from DB:", err);
    process.exit(1);
  } finally {
    console.log("Closing initial DB connection (preventing timeouts during AWS indexing)...");
    await client.end();
  }

  // 3. Filter missing employees
  const missingEmployees = dbRows.filter(row => !enrolledEmpIdsInCollection.has(String(row.emp_id)));
  console.log(`Step 3: Found ${missingEmployees.length} employees missing from Rekognition collection.`);

  if (missingEmployees.length === 0) {
    console.log("All employees are already indexed. Done!");
    process.exit(0);
  }

  // 4. Index in parallel with concurrency control
  console.log(`Step 4: Starting parallel indexing with concurrency of ${CONCURRENCY}...`);
  let activeIndex = 0;
  let successfulIndexes = [];
  let failedCount = 0;
  let indexedCount = 0;

  async function worker() {
    while (true) {
      const currentIdx = activeIndex++;
      if (currentIdx >= missingEmployees.length) {
        break;
      }

      const emp = missingEmployees[currentIdx];
      const s3Key = parseFaceKey(emp.face_embedding);
      if (!s3Key) {
        failedCount++;
        continue;
      }

      try {
        const s3Resp = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: s3Key }));
        const chunks = [];
        for await (const chunk of s3Resp.Body) chunks.push(chunk);
        const imageBytes = Buffer.concat(chunks);

        const indexResp = await rekognition.send(
          new IndexFacesCommand({
            CollectionId: collectionId,
            Image: { Bytes: imageBytes },
            ExternalImageId: emp.emp_id.toString(),
            MaxFaces: 1,
            QualityFilter: "NONE",
          })
        );

        const newFaceRecord = indexResp.FaceRecords?.[0];
        if (newFaceRecord) {
          successfulIndexes.push({
            emp_id: emp.emp_id,
            face_id: newFaceRecord.Face.FaceId,
            face_confidence: newFaceRecord.Face.Confidence
          });
          indexedCount++;
          if (indexedCount % 50 === 0) {
            console.log(`Progress: Indexed ${indexedCount}/${missingEmployees.length} (Failed: ${failedCount})`);
          }
        } else {
          failedCount++;
        }
      } catch (err) {
        // console.error(`Failed emp_id=${emp.emp_id}:`, err.message);
        failedCount++;
      }
    }
  }

  // Start parallel workers
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`\nStep 5: AWS Indexing finished. Indexed: ${successfulIndexes.length}, Failed: ${failedCount}`);

  // 5. Bulk update the database in batches
  if (successfulIndexes.length > 0) {
    console.log(`Step 6: Updating database with new Face IDs in batches of ${BATCH_UPDATE_SIZE}...`);
    const updateClient = getDbClient();
    try {
      await updateClient.connect();
      for (let i = 0; i < successfulIndexes.length; i += BATCH_UPDATE_SIZE) {
        const batch = successfulIndexes.slice(i, i + BATCH_UPDATE_SIZE);
        await updateClient.query("BEGIN");
        for (const item of batch) {
          await updateClient.query(
            "UPDATE employee SET face_id = $1, face_confidence = $2 WHERE emp_id = $3",
            [item.face_id, item.face_confidence, item.emp_id]
          );
        }
        await updateClient.query("COMMIT");
        console.log(`DB Update Progress: ${Math.min(i + BATCH_UPDATE_SIZE, successfulIndexes.length)}/${successfulIndexes.length}`);
      }
    } catch (err) {
      console.error("Failed to update database:", err);
    } finally {
      await updateClient.end();
      console.log("DB connections closed.");
    }
  }

  console.log("=== INDEXING PROCESS COMPLETE ===");
  process.exit(0);
}

run();
