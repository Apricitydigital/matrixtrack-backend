require("dotenv").config();
const { s3, HeadObjectCommand, ListObjectsV2Command } = require("./config/awsConfig");
const pool = require("./config/db");
const { parseFaceKey } = require("./utils/faceImage");

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME || null;
const secondaryBucketName = process.env.SECONDARY_S3_BUCKET || null;
const SUPERVISOR = process.env.HEAL_SUPERVISOR_ID
  ? Number(process.env.HEAL_SUPERVISOR_ID)
  : null; // null => all supervisors
const BATCH_SIZE = Number(process.env.HEAL_BATCH_SIZE || 2000);

if (!bucketName) {
  console.error("No bucket configured");
  process.exit(1);
}
const buckets = [bucketName, secondaryBucketName].filter(Boolean);

async function headKey(key) {
  for (const b of buckets) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: b, Key: key }));
      return true;
    } catch (_) {}
  }
  return false;
}

async function findNewest(empId, empCode) {
  const prefixes = [
    `faces/${empId}/`,
    empCode ? `faces/${empCode}/` : null,
    `${empId}/`,
    empCode ? `${empCode}/` : null,
  ].filter(Boolean);
  for (const prefix of prefixes) {
    for (const b of buckets) {
      try {
        const resp = await s3.send(
          new ListObjectsV2Command({ Bucket: b, Prefix: prefix, MaxKeys: 5 })
        );
        const c = resp?.Contents || [];
        if (!c.length) continue;
        c.sort(
          (a, b2) =>
            new Date(b2.LastModified || 0) - new Date(a.LastModified || 0)
        );
        return c[0].Key;
      } catch (_) {}
    }
  }
  return null;
}

(async () => {
  let offset = 0;
  let checked = 0,
    healed = 0,
    missing = 0;

  while (true) {
    const baseQuery = `
      SELECT e.emp_id, e.emp_code, e.face_embedding
        FROM employee e
        ${SUPERVISOR ? "JOIN supervisor_ward sw ON sw.ward_id = e.ward_id" : ""}
       WHERE e.face_embedding IS NOT NULL
       ${SUPERVISOR ? "AND sw.supervisor_id = $1" : ""}
       ORDER BY e.emp_id
       LIMIT $${SUPERVISOR ? 2 : 1} OFFSET $${SUPERVISOR ? 3 : 2}
    `;
    const params = SUPERVISOR
      ? [SUPERVISOR, BATCH_SIZE, offset]
      : [BATCH_SIZE, offset];
    const { rows } = await pool.query(baseQuery, params);
    if (!rows.length) break;

    for (const row of rows) {
      checked++;
      const key = parseFaceKey(row.face_embedding);
      if (key && (await headKey(key))) continue;
      const rep = await findNewest(row.emp_id, row.emp_code);
      if (!rep) {
        missing++;
        continue;
      }
      await pool.query("UPDATE employee SET face_embedding=$1 WHERE emp_id=$2", [
        rep,
        row.emp_id,
      ]);
      healed++;
    }

    offset += BATCH_SIZE;
    console.log(`Progress: checked ${checked}, healed ${healed}, missing ${missing}`);
  }

  console.log({ checked, healed, missing });
  await pool.end();
  process.exit(0);
})();
