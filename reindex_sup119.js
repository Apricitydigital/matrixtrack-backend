require("dotenv").config();
const { rekognition, IndexFacesCommand, CreateCollectionCommand } = require("./config/awsConfig");
const pool = require("./config/db");
const { parseFaceKey } = require("./utils/faceImage");

(async () => {
  const sup = 119;
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const collection = (process.env.REKOGNITION_COLLECTION || process.env.REKOGNITION_COLLECTION_ID || "employee").trim();

  try { await rekognition.send(new CreateCollectionCommand({ CollectionId: collection })); } catch (_) {}

  const { rows } = await pool.query(`
    select e.emp_id, e.face_embedding
      from employee e
      join supervisor_ward sw on sw.ward_id = e.ward_id
     where sw.supervisor_id = $1
       and e.face_embedding is not null
  `, [sup]);

  let indexed = 0, failed = 0;
  for (const r of rows) {
    const key = parseFaceKey(r.face_embedding);
    if (!key) { failed++; continue; }
    try {
      await rekognition.send(new IndexFacesCommand({
        CollectionId: collection,
        ExternalImageId: String(r.emp_id),
        Image: { S3Object: { Bucket: bucket, Name: key } },
        MaxFaces: 1,
        QualityFilter: "HIGH",
      }));
      indexed++;
    } catch (err) { failed++; console.error("Index fail emp", r.emp_id, err.message); }
  }
  console.log({ indexed, failed });
  await pool.end();
  process.exit(0);
})();
