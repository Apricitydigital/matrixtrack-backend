const express = require("express");
const router = express.Router();
const axios = require("axios");
const path = require("path");
const sharp = require("sharp");
const { Readable } = require("stream");
const {
  rekognition,
  s3,
  IndexFacesCommand,
  CreateCollectionCommand,
  DeleteFacesCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require("../../config/awsConfig");
const pool = require("../../config/db");
const upload = require("../../middleware/upload");
const { buildPublicFaceUrl, parseFaceKey } = require("../../utils/faceImage");
const {
  hasBackblazeCredentials,
  isBackblazeUrl,
  parseBackblazeUrl,
  fetchBackblazeStream,
} = require("../../utils/backblaze");

const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME || null;
const secondaryBucketName = process.env.SECONDARY_S3_BUCKET || null;
const DEFAULT_FACE_PREFIX = "faces/";

// Simple in-memory cache for missing images to avoid recurring expensive S3 scans
const MISSING_FACE_CACHE = new Set();
// Cache for recently found keys via recovery to avoid redundant scans
const FOUND_FACE_CACHE = new Map();

// Clean caches every 10 minutes
setInterval(() => {
  MISSING_FACE_CACHE.clear();
  FOUND_FACE_CACHE.clear();
}, 10 * 60 * 1000);

const resetFaceCaches = () => {
  MISSING_FACE_CACHE.clear();
  FOUND_FACE_CACHE.clear();
};

const rssToMb = (rss) => Number((rss / (1024 * 1024)).toFixed(1));

const createRouteMetrics = (route, req) => ({
  route,
  startedAt: Date.now(),
  imageBytes:
    req?.file?.size ||
    req?.file?.buffer?.length ||
    req?.file?.transforms?.[0]?.size ||
    0,
  facesDetected: 0,
  fallbackCandidates: 0,
  rekognitionCalls: 0,
  rssBeforeMb: rssToMb(process.memoryUsage().rss),
});

const finalizeRouteMetrics = (metrics) => {
  if (!metrics) {
    return;
  }

  const durationMs = Date.now() - metrics.startedAt;
  const rssAfterMb = rssToMb(process.memoryUsage().rss);
  console.log(
    '[perf] route=' + metrics.route +
      ' durationMs=' + durationMs +
      ' imageBytes=' + metrics.imageBytes +
      ' facesDetected=' + metrics.facesDetected +
      ' fallbackCandidates=' + metrics.fallbackCandidates +
      ' rekognitionCalls=' + metrics.rekognitionCalls +
      ' rssBeforeMb=' + metrics.rssBeforeMb +
      ' rssAfterMb=' + rssAfterMb
  );
};

// ðŸ”€ Admin utility: clear face caches on demand (no data is deleted)
router.post("/clear-cache", (req, res) => {
  const missingSize = MISSING_FACE_CACHE.size;
  const foundSize = FOUND_FACE_CACHE.size;
  resetFaceCaches();
  res.json({
    success: true,
    cleared: { missing: missingSize, found: foundSize },
  });
});

const resolvePrefix = (rawPrefix) => {
  const candidate = typeof rawPrefix === "string" ? rawPrefix.trim() : "";
  if (candidate.length === 0) {
    return DEFAULT_FACE_PREFIX;
  }
  return candidate.endsWith("/") ? candidate : `${candidate}/`;
};

const normalizeId = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveSupervisorIdFromQuery = (query = {}) => {
  const keys = ["supervisor_id", "supervisorId", "user_id", "userId"];
  for (const key of keys) {
    const candidate = normalizeId(query?.[key]);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
};

const buildFaceImageUrlFromEmbedding = (embedding, empId) => {
  if (!embedding) return null;

  // If it's already an absolute URL (S3, CloudFront, or Backblaze), use it directly
  // to bypass backend overhead (HeadObject, Sharp, etc.) and improve speed.
  if (typeof embedding === "string" && embedding.startsWith("http")) {
    return embedding;
  }

  // If empId is provided, we can use the backend proxy which handles
  // Sharp compression, secondary bucket failover, and prefix recovery.
  if (empId) {
    return `app/attendance/employee/faceRoutes/image/${empId}`;
  }

  const faceImageUrl = buildPublicFaceUrl(embedding);
  return faceImageUrl || embedding || null;
};

async function fetchSupervisorFaceGallery(supervisorId, wardId) {
  const { rows } = await pool.query(
    `
      SELECT DISTINCT ON (e.emp_id)
             e.emp_id,
             e.emp_code,
             e.name AS employee_name,
             e.face_embedding,
             e.face_id,
             e.face_confidence,
             w.ward_id,
             w.ward_name,
             z.zone_name,
             c.city_name
        FROM employee e
        LEFT JOIN wards w ON e.ward_id = w.ward_id
        LEFT JOIN zones z ON w.zone_id = z.zone_id
        LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE (e.face_embedding IS NOT NULL OR e.face_id IS NOT NULL)
         AND ($2::int IS NULL OR w.ward_id = $2::int)
         AND (
           EXISTS (
             SELECT 1 FROM supervisor_ward sw
             WHERE sw.ward_id = e.ward_id AND sw.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_kothi_access uk
             WHERE uk.ward_id = e.ward_id AND uk.user_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM supervisor_kothi sk
             WHERE sk.ward_id = e.ward_id AND sk.supervisor_id = $1
           )
           OR EXISTS (
             SELECT 1 FROM user_zone_access uz
             WHERE uz.zone_id = w.zone_id AND uz.user_id = $1
           )
         )
        ORDER BY e.emp_id
    `,
    [supervisorId, wardId]
  );

  const uniqueMap = new Map();

  rows.forEach((row) => {
    const key = String(row.emp_id);
    if (uniqueMap.has(key)) {
      return;
    }

    const url = buildFaceImageUrlFromEmbedding(row.face_embedding, row.emp_id);

    uniqueMap.set(key, {
      employeeId: row.emp_id,
      employee_id: row.emp_id,
      empId: row.emp_id,
      emp_id: row.emp_id,
      employeeName: row.employee_name,
      name: row.employee_name,
      employeeCode: row.emp_code,
      emp_code: row.emp_code,
      code: row.emp_code,
      identifier: row.emp_code || String(row.emp_id),
      wardId: row.ward_id,
      ward_id: row.ward_id,
      wardName: row.ward_name,
      zoneName: row.zone_name,
      cityName: row.city_name,
      faceId: row.face_id,
      face_id: row.face_id,
      faceConfidence: row.face_confidence,
      face_confidence: row.face_confidence,
      key: row.face_embedding,
      imageKey: row.face_embedding,
      url,
      source: "supervisor",
    });
  });

  return Array.from(uniqueMap.values());
}

const resolveCollectionId = () => {
  const id =
    (process.env.REKOGNITION_COLLECTION || "").trim() ||
    (process.env.REKOGNITION_COLLECTION_ID || "").trim();
  return id || null;
};

let collectionReady = false;

const ensureCollectionExists = async (collectionId) => {
  if (collectionReady) {
    return;
  }

  try {
    await rekognition.send(
      new CreateCollectionCommand({
        CollectionId: collectionId,
      })
    );
    console.log(`Created Rekognition collection "${collectionId}".`);
  } catch (error) {
    if (error.name === "ResourceAlreadyExistsException") {
      // Collection already present; carry on.
      console.log(`Rekognition collection "${collectionId}" already exists.`);
    } else {
      throw error;
    }
  }

  collectionReady = true;
};

const extractIdentifierFromKey = (key, prefix) => {
  if (!key || typeof key !== "string") {
    return null;
  }

  const normalizedPrefix = prefix || "";
  const stripped = normalizedPrefix && key.startsWith(normalizedPrefix)
    ? key.slice(normalizedPrefix.length)
    : key;

  const [identifier] = stripped.split("/");
  return identifier || null;
};

const parseEmployeeId = (identifier) => {
  if (!identifier) {
    return null;
  }

  const numericCandidate = Number(identifier);
  if (Number.isFinite(numericCandidate)) {
    return numericCandidate;
  }

  const digitsOnly = identifier.replace(/\D+/g, "");
  if (!digitsOnly) {
    return null;
  }

  const parsed = Number(digitsOnly);
  return Number.isFinite(parsed) ? parsed : null;
};

const streamS3Object = async (key, targetBucket = bucketName) => {
  if (!targetBucket) {
    throw new Error("S3 bucket is not configured");
  }

  const command = new GetObjectCommand({
    Bucket: targetBucket,
    Key: key,
  });

  const response = await s3.send(command);
  const body = response.Body;
  const stream =
    typeof body?.pipe === "function" ? body : Readable.from(body ?? []);

  return {
    stream,
    contentType: response.ContentType || "image/jpeg",
  };
};

/**
 * 🛠️ Reconciliation Utility
 * Scans S3 and populates missing face_embedding fields in the database.
 */
router.get("/reconcile-all", async (req, res) => {
  if (!bucketName) {
    return res.status(500).json({ error: "S3 bucket is not configured" });
  }

  try {
    const prefix = "faces/";
    let continuationToken = undefined;
    let scannedCount = 0;
    let reconciledCount = 0;
    const errors = [];

    console.log("[Reconcile] Starting bulk reconciliation...");

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await s3.send(command);
      const contents = response?.Contents || [];

      for (const item of contents) {
        if (!item?.Key || item.Key.endsWith("/")) continue;
        scannedCount++;

        const identifier = extractIdentifierFromKey(item.Key, prefix);
        const employeeId = parseEmployeeId(identifier);

        if (employeeId) {
          try {
            // Update if face_embedding is NULL or matches but might be outdated
            const result = await pool.query(
              `UPDATE employee 
               SET face_embedding = $1 
               WHERE (emp_id = $2 OR emp_code = $3) 
               AND (face_embedding IS NULL OR face_embedding = $4)
               RETURNING emp_id`,
              [item.Key, employeeId, identifier, identifier]
            );

            if (result.rowCount > 0) {
              reconciledCount++;
            }
          } catch (dbError) {
            errors.push({ key: item.Key, error: dbError.message });
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    console.log(`[Reconcile] Finished. Scanned: ${scannedCount}, Reconciled: ${reconciledCount}`);

    // Clear caches to reflect new data
    MISSING_FACE_CACHE.clear();
    FOUND_FACE_CACHE.clear();

    res.json({
      success: true,
      message: "Bulk reconciliation completed successfully",
      scanned: scannedCount,
      reconciled: reconciledCount,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });
  } catch (error) {
    console.error("Bulk reconciliation failed:", error);
    res.status(500).json({
      error: "Reconciliation failed",
      details: error.message,
    });
  }
});

/**
 * 🔧 Auto-heal face embeddings for all employees:
 * - Verifies the stored key exists in S3 (primary or secondary).
 * - If missing or stored under a different identifier folder, picks the newest key under
 *   faces/{emp_id}/ or faces/{emp_code}/ and updates employee.face_embedding.
 * - Skips already-valid rows to keep it fast.
 *
 * This lets us fix mismatched face gallery tiles without re-capturing 40k users.
 */
router.post("/auto-heal", async (req, res) => {
  if (!bucketName) {
    return res.status(500).json({ error: "S3 bucket is not configured" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT emp_id, emp_code, face_embedding
         FROM employee
        WHERE face_embedding IS NOT NULL`
    );

    let checked = 0;
    let healed = 0;
    let missing = 0;
    const errors = [];

    const buckets = [bucketName, secondaryBucketName].filter(Boolean);

    const headKey = async (key) => {
      for (const b of buckets) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: b, Key: key }));
          return b;
        } catch (_e) { }
      }
      return null;
    };

    const findNewestInPrefixes = async (empId, empCode) => {
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
              new ListObjectsV2Command({
                Bucket: b,
                Prefix: prefix,
                MaxKeys: 50,
              })
            );
            const contents = resp?.Contents || [];
            if (!contents.length) continue;
            contents.sort(
              (a, b2) =>
                new Date(b2.LastModified || 0) -
                new Date(a.LastModified || 0)
            );
            return { key: contents[0].Key, bucket: b };
          } catch (_e) { }
        }
      }
      return null;
    };

    for (const row of rows) {
      checked += 1;
      const empId = row.emp_id;
      const empCode = row.emp_code;
      const storedKey = parseFaceKey(row.face_embedding);

      // Fast path: key exists where it is
      if (storedKey && (await headKey(storedKey))) {
        continue;
      }

      const replacement = await findNewestInPrefixes(empId, empCode);
      if (!replacement) {
        missing += 1;
        continue;
      }

      try {
        await pool.query(
          "UPDATE employee SET face_embedding = $1 WHERE emp_id = $2",
          [replacement.key, empId]
        );
        healed += 1;
      } catch (e) {
        errors.push({ empId, error: e.message });
      }
    }

    // Clear caches so downstream requests see fresh keys
    MISSING_FACE_CACHE.clear();
    FOUND_FACE_CACHE.clear();

    res.json({
      success: true,
      employees_checked: checked,
      healed,
      missing_after_scan: missing,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    console.error("Auto-heal faces failed:", error);
    res.status(500).json({
      error: "Auto-heal failed",
      details: error.message,
    });
  }
});

/**
 * 🔄 Reindex-All: Re-indexes every employee's existing S3 face image into
 * the Rekognition collection.  Use this to fix "group punch unrecognized"
 * for employees whose face_id is stale or orphaned in the collection.
 * Safe to run repeatedly — it skips employees with no face_embedding.
 */
router.post("/reindex-all", async (req, res) => {
  if (!bucketName) {
    return res.status(500).json({ error: "S3 bucket is not configured" });
  }

  const collectionId = resolveCollectionId();
  if (!collectionId) {
    return res.status(500).json({ error: "Rekognition collection is not configured" });
  }

  try {
    await ensureCollectionExists(collectionId);

    // Fetch all employees who have an S3 face key
    const { rows } = await pool.query(
      `SELECT emp_id, emp_code, face_embedding, face_id FROM employee WHERE face_embedding IS NOT NULL`
    );

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const row of rows) {
      const { parseFaceKey: _parseFaceKey } = require("../../utils/faceImage");
      const s3Key = _parseFaceKey(row.face_embedding);

      if (!s3Key) {
        skipped++;
        continue;
      }

      // Verify the S3 key exists
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
      } catch (_e) {
        // Try with secondary bucket
        let foundInSecondary = false;
        if (secondaryBucketName) {
          try {
            await s3.send(new HeadObjectCommand({ Bucket: secondaryBucketName, Key: s3Key }));
            foundInSecondary = true;
          } catch (_e2) { }
        }
        if (!foundInSecondary) {
          skipped++;
          continue; // S3 key doesn't exist in any bucket, skip
        }
      }

      try {
        // Remove old face_id from collection to avoid duplicates
        if (row.face_id) {
          try {
            await rekognition.send(
              new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: [row.face_id] })
            );
          } catch (_del) { /* ignore - may already be gone */ }
        }

        // Re-index the face
        const indexResp = await rekognition.send(
          new IndexFacesCommand({
            CollectionId: collectionId,
            Image: { S3Object: { Bucket: bucketName, Name: s3Key } },
            ExternalImageId: row.emp_id.toString(),
            DetectionAttributes: ["DEFAULT"],
            MaxFaces: 1,
            QualityFilter: "NONE", // Use NONE so lower-quality legacy images still get indexed
          })
        );

        const newFaceRecord = indexResp.FaceRecords?.[0];
        if (!newFaceRecord) {
          errors.push({ empId: row.emp_id, error: "No face detected in stored image" });
          failed++;
          continue;
        }

        const newFaceId = newFaceRecord.Face.FaceId;
        const newConfidence = newFaceRecord.Face.Confidence;

        // Update DB with new face_id
        await pool.query(
          `UPDATE employee SET face_id = $1, face_confidence = $2 WHERE emp_id = $3`,
          [newFaceId, newConfidence, row.emp_id]
        );

        MISSING_FACE_CACHE.delete(row.emp_id);
        FOUND_FACE_CACHE.delete(row.emp_id);
        indexed++;
      } catch (rekErr) {
        errors.push({ empId: row.emp_id, error: rekErr.message });
        failed++;
      }
    }

    console.log(`[ReindexAll] Total: ${rows.length}, Indexed: ${indexed}, Skipped: ${skipped}, Failed: ${failed}`);

    res.json({
      success: true,
      message: "Reindex completed",
      total: rows.length,
      indexed,
      skipped,
      failed,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error("[ReindexAll] Fatal error:", error);
    res.status(500).json({ error: "Reindex failed", details: error.message });
  }
});

/**
 * 🎯 Targeted Reindex: Re-indexes specific employees' existing S3 face images into
 * the Rekognition collection. Accepts emp_ids or emp_codes in request body.
 */
router.post("/reindex-targeted", async (req, res) => {
  const { emp_ids, emp_codes } = req.body;

  if (!Array.isArray(emp_ids) && !Array.isArray(emp_codes)) {
    return res.status(400).json({
      error: "Provide an array of emp_ids or emp_codes",
    });
  }

  if (!bucketName) {
    return res.status(500).json({ error: "S3 bucket is not configured" });
  }

  const collectionId = resolveCollectionId();
  if (!collectionId) {
    return res.status(500).json({ error: "Rekognition collection is not configured" });
  }

  try {
    await ensureCollectionExists(collectionId);

    let query = "SELECT emp_id, emp_code, face_embedding, face_id FROM employee WHERE face_embedding IS NOT NULL";
    const params = [];

    if (Array.isArray(emp_ids) && emp_ids.length > 0) {
      query += ` AND emp_id = ANY($1)`;
      params.push(emp_ids);
    } else if (Array.isArray(emp_codes) && emp_codes.length > 0) {
      query += ` AND emp_code = ANY($1)`;
      params.push(emp_codes);
    }

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No employees found with face enrollment for provided identifiers",
      });
    }

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const row of rows) {
      const { parseFaceKey: _parseFaceKey } = require("../../utils/faceImage");
      const s3Key = _parseFaceKey(row.face_embedding);

      if (!s3Key) {
        skipped++;
        continue;
      }

      // Verify the S3 key exists
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
      } catch (_e) {
        // Try with secondary bucket
        let foundInSecondary = false;
        if (secondaryBucketName) {
          try {
            await s3.send(new HeadObjectCommand({ Bucket: secondaryBucketName, Key: s3Key }));
            foundInSecondary = true;
          } catch (_e2) { }
        }
        if (!foundInSecondary) {
          skipped++;
          continue; // S3 key doesn't exist in any bucket, skip
        }
      }

      try {
        // Remove old face_id from collection to avoid duplicates
        if (row.face_id) {
          try {
            await rekognition.send(
              new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: [row.face_id] })
            );
          } catch (_del) { /* ignore - may already be gone */ }
        }

        // Re-index the face
        const indexResp = await rekognition.send(
          new IndexFacesCommand({
            CollectionId: collectionId,
            Image: { S3Object: { Bucket: bucketName, Name: s3Key } },
            ExternalImageId: row.emp_id.toString(),
            DetectionAttributes: ["DEFAULT"],
            MaxFaces: 1,
            QualityFilter: "NONE", // Use NONE so lower-quality legacy images still get indexed
          })
        );

        const newFaceRecord = indexResp.FaceRecords?.[0];
        if (!newFaceRecord) {
          errors.push({ empId: row.emp_id, error: "No face detected in stored image" });
          failed++;
          continue;
        }

        const newFaceId = newFaceRecord.Face.FaceId;
        const newConfidence = newFaceRecord.Face.Confidence;

        // Update DB with new face_id
        await pool.query(
          `UPDATE employee SET face_id = $1, face_confidence = $2 WHERE emp_id = $3`,
          [newFaceId, newConfidence, row.emp_id]
        );

        MISSING_FACE_CACHE.delete(row.emp_id);
        FOUND_FACE_CACHE.delete(row.emp_id);
        indexed++;
      } catch (rekErr) {
        errors.push({ empId: row.emp_id, error: rekErr.message });
        failed++;
      }
    }

    res.json({
      success: true,
      message: "Targeted reindex completed",
      total: rows.length,
      indexed,
      skipped,
      failed,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error("[ReindexTargeted] Fatal error:", error);
    res.status(500).json({ error: "Targeted reindex failed", details: error.message });
  }
});

router.get("/gallery", async (req, res) => {
  // Never let an HTTP cache serve a stale gallery list
  res.set("Cache-Control", "no-store");
  // PROD SAFETY: Do NOT flush face caches on every gallery load.
  // Previously resetFaceCaches() here defeated FOUND_FACE_CACHE and MISSING_FACE_CACHE,
  // causing every subsequent /image/:id to re-do S3 prefix scans and sharp recompress.
  // Use the dedicated POST /clear-cache endpoint to flush caches explicitly when needed.

  const supervisorId = resolveSupervisorIdFromQuery(req.query);
  const wardId = normalizeId(req.query?.ward_id ?? req.query?.wardId ?? null);

  if (supervisorId !== null) {
    try {
      const data = await fetchSupervisorFaceGallery(supervisorId, wardId);
      return res.json({
        success: true,
        scope: "supervisor",
        supervisor_id: supervisorId,
        ward_id: wardId,
        count: data.length,
        data,
      });
    } catch (error) {
      console.error("Supervisor face gallery fetch error:", error);
      return res.status(500).json({
        error: "Unable to fetch supervisor face gallery",
        details: error.message,
      });
    }
  }

  if (!bucketName) {
    return res.status(500).json({
      error: "S3 bucket is not configured",
      details: "Set AWS_S3_BUCKET or S3_BUCKET_NAME in the backend environment.",
    });
  }

  const prefix = resolvePrefix(req.query.prefix || DEFAULT_FACE_PREFIX);
  const maxKeys = Math.min(
    Math.max(Number(req.query.maxKeys) || 200, 1),
    1000
  );

  const images = [];
  let continuationToken = undefined;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: maxKeys,
      });

      const response = await s3.send(command);
      const contents = response?.Contents || [];

      contents.forEach((item) => {
        if (!item?.Key || item.Key.endsWith("/")) {
          return;
        }

        const identifier = extractIdentifierFromKey(item.Key, prefix);
        const employeeId = parseEmployeeId(identifier);

        images.push({
          key: item.Key,
          identifier,
          employeeId,
          size: item.Size ?? null,
          lastModified: item.LastModified ?? null,
          url: employeeId
            ? `app/attendance/employee/faceRoutes/image/${employeeId}`
            : buildPublicFaceUrl(item.Key),
        });
      });

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    const dedupMap = new Map();
    images.forEach((item) => {
      const identifier =
        item.employeeId !== null && item.employeeId !== undefined
          ? String(item.employeeId)
          : item.identifier
            ? String(item.identifier)
            : item.key;
      const dedupKey = identifier ? identifier.toLowerCase() : item.key;
      const existing = dedupMap.get(dedupKey);

      const currentTimestamp = item.lastModified
        ? new Date(item.lastModified).getTime()
        : 0;
      const existingTimestamp = existing?.lastModified
        ? new Date(existing.lastModified).getTime()
        : -Infinity;

      if (!existing || currentTimestamp > existingTimestamp) {
        dedupMap.set(dedupKey, item);
      }
    });

    const uniqueImages = Array.from(dedupMap.values());

    res.json({
      success: true,
      bucket: bucketName,
      prefix,
      count: uniqueImages.length,
      images: uniqueImages,
    });
  } catch (error) {
    console.error("Face gallery fetch error:", error);
    res.status(500).json({
      error: "Unable to list face images",
      details: error.message,
    });
  }
});

router.get("/image/:employeeId", async (req, res) => {
  const routeMetrics = createRouteMetrics("face-image", req);
  try {
    const employeeId = normalizeId(req.params.employeeId);

    if (employeeId === null) {
      return res.status(400).json({ error: "Valid employee ID is required" });
    }

    // Short-circuit if we recently confirmed this employee has no photo
    if (MISSING_FACE_CACHE.has(employeeId) && !req.query.force) {
      return res.status(404).json({ error: "Face image not found (cached)" });
    }

    const { rows } = await pool.query(
      `SELECT face_embedding, emp_code
         FROM employee
         WHERE emp_id = $1`,
      [employeeId]
    );

    const empCode = rows.length ? rows[0].emp_code : null;
    let faceEmbedding = rows.length ? rows[0].face_embedding : null;
    const defaultName = `employee_${employeeId}_face.jpg`;

    let objectKey = parseFaceKey(faceEmbedding);
    let keyExists = false;


    if (!faceEmbedding) {
      MISSING_FACE_CACHE.add(employeeId);
      return res.status(404).json({ error: "Face image not stored for this employee" });
    }

    const tryProxyHttp = async (url, name = defaultName) => {
      if (!url) return false;
      const imageResponse = await axios.get(url, {
        responseType: "stream",
      });

      res.set({
        "Content-Type": imageResponse.headers["content-type"] || "image/jpeg",
        "Content-Disposition": `inline; filename="${path.basename(name) || defaultName}"`,
        "Cache-Control": "private, max-age=60",
      });

      // 🖼 Compression Proxy using Sharp
      const isThumb = req.query.thumb === '1';
      const quality = isThumb ? 70 : 85;
      const width = isThumb ? 300 : 800;

      const transformer = sharp()
        .resize(width, null, { withoutEnlargement: true })
        .jpeg({ quality, progressive: true });

      imageResponse.data.pipe(transformer).pipe(res);
      return true;
    };

    if (isBackblazeUrl(faceEmbedding)) {
      const reference = parseBackblazeUrl(faceEmbedding);
      if (!reference?.bucket || !reference?.key) {
        return res.status(404).json({ error: "Face image not found" });
      }

      if (hasBackblazeCredentials()) {
        try {
          const { stream, contentType } = await fetchBackblazeStream(
            reference.bucket,
            reference.key
          );

          const isThumb = req.query.thumb === '1';
          const quality = isThumb ? 70 : 85;
          const width = isThumb ? 300 : 800;

          const transformer = sharp()
            .resize(width, null, { withoutEnlargement: true })
            .jpeg({ quality, progressive: true });

          res.set({
            "Content-Type": "image/jpeg",
            "Content-Disposition": `inline; filename="${path.basename(reference.key) || defaultName}"`,
            "Cache-Control": "private, max-age=60",
          });

          return stream.pipe(transformer).pipe(res);
        } catch (error) {
          if (error?.response?.status === 404) {
            return res.status(404).json({ error: "Face image not found" });
          }
          console.warn(
            "Backblaze credentialed fetch failed, attempting unauthenticated fallback.",
            error?.message || error
          );
        }
      } else {
        console.warn(
          "Backblaze credentials not configured; falling back to public download for face image."
        );
      }

      try {
        const imageResponse = await axios.get(faceEmbedding, {
          responseType: "stream",
        });

        const isThumb = req.query.thumb === '1';
        const quality = isThumb ? 70 : 85;
        const width = isThumb ? 300 : 800;

        const transformer = sharp()
          .resize(width, null, { withoutEnlargement: true })
          .jpeg({ quality, progressive: true });

        res.set({
          "Content-Type": "image/jpeg",
          "Content-Disposition": `inline; filename="${path.basename(reference.key) || defaultName}"`,
          "Cache-Control": "private, max-age=60",
        });

        return imageResponse.data.pipe(transformer).pipe(res);
      } catch (error) {
        console.error("Error proxying Backblaze face image:", error);
        const publicFallback =
          buildPublicFaceUrl(faceEmbedding) || faceEmbedding || null;
        try {
          const proxied = await tryProxyHttp(publicFallback, reference.key);
          if (proxied) return;
        } catch (proxyError) {
          console.error("Backblaze public proxy fallback failed:", proxyError);
        }
        return res
          .status(502)
          .json({ error: "Unable to fetch face image from Backblaze" });
      }
    }

    objectKey = parseFaceKey(faceEmbedding);
    if (objectKey) {
      let finalBucket = bucketName;
      let streamResult = null;

      // Try primary bucket first
      try {
        streamResult = await streamS3Object(objectKey, bucketName);
      } catch (e) {
        // If fail in primary, try secondary bucket
        if (secondaryBucketName) {
          try {
            streamResult = await streamS3Object(objectKey, secondaryBucketName);
            finalBucket = secondaryBucketName;
          } catch (e2) {
            streamResult = null;
          }
        }
      }

      if (!streamResult) {
        // Short-circuit if we already found this key via recovery in this session
        if (FOUND_FACE_CACHE.has(employeeId)) {
          const cachedKey = FOUND_FACE_CACHE.get(employeeId);
          try {
            streamResult = await streamS3Object(cachedKey, bucketName);
            objectKey = cachedKey;
          } catch (e) { }
        }

        if (!streamResult) {
          // 🚀 Optimization: Parallelize prefix scans
          const candidatePrefixes = [
            `faces/${employeeId}/`,
            empCode ? `faces/${empCode}/` : null,
            `${employeeId}/`,
            empCode ? `${empCode}/` : null,
          ].filter(Boolean);

          const scanResults = await Promise.all(
            candidatePrefixes.map(async (prefix) => {
              try {
                const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, MaxKeys: 1 }));
                return resp.Contents && resp.Contents.length > 0 ? resp.Contents[0].Key : null;
              } catch (err) {
                return null;
              }
            })
          );

          const bestKey = scanResults.find(Boolean);
          if (bestKey) {
            try {
              streamResult = await streamS3Object(bestKey, bucketName);
              objectKey = bestKey;

              // 🛡️ Self-Healing: Backfill the database so next time is a direct hit
              FOUND_FACE_CACHE.set(employeeId, bestKey);
              pool.query(
                "UPDATE employee SET face_embedding = $1 WHERE emp_id = $2",
                [bestKey, employeeId]
              ).catch(e => console.error(`Failed to backfill face_embedding for ${employeeId}:`, e));

              console.log(`[Self-Healing] Backfilled face_embedding for employee ${employeeId} with key: ${bestKey}`);
            } catch (err) { }
          }
        }
      }

      if (!streamResult) {
        MISSING_FACE_CACHE.add(employeeId);
        return res.status(404).json({ error: "Face image not found in any bucket" });
      }

      try {
        const { stream, contentType } = streamResult;

        const isThumb = req.query.thumb === '1';
        const quality = isThumb ? 70 : 85;
        const width = isThumb ? 300 : 800;

        const transformer = sharp()
          .resize(width, null, { withoutEnlargement: true })
          .jpeg({ quality, progressive: true });

        res.set({
          "Content-Type": "image/jpeg",
          "Content-Disposition": `inline; filename="${path.basename(objectKey) || defaultName}"`,
          "Cache-Control": "private, max-age=60",
        });

        return stream.pipe(transformer).pipe(res);
      } catch (error) {
        console.error("Error streaming S3 face image:", error);
        const isOurBucketUrl =
          typeof faceEmbedding === "string" &&
          bucketName &&
          faceEmbedding.includes(bucketName);
        // If this is our private bucket, avoid proxying a public request that will 403.
        if (isOurBucketUrl) {
          return res.status(404).json({ error: "Face image not found" });
        }
        const publicFallback =
          buildPublicFaceUrl(faceEmbedding) || faceEmbedding || null;
        try {
          const proxied = await tryProxyHttp(publicFallback, objectKey);
          if (proxied) return;
        } catch (proxyError) {
          console.error("S3 proxy fallback failed:", proxyError);
        }

        const statusCode = error?.$metadata?.httpStatusCode;
        const code = statusCode && Number.isFinite(Number(statusCode))
          ? Number(statusCode)
          : 500;
        if (code === 404 || code === 403) {
          return res.status(404).json({ error: "Face image not found" });
        }
        return res.status(500).json({ error: "Unable to fetch face image" });
      }
    }

    if (typeof faceEmbedding === "string" && faceEmbedding.startsWith("http")) {
      const objectKeyFromUrl = parseFaceKey(faceEmbedding);
      const isOurBucketUrl =
        bucketName && objectKeyFromUrl && faceEmbedding.includes(bucketName);

      // Try credentialed S3 fetch first whenever we can resolve a key
      if (bucketName && objectKeyFromUrl) {
        try {
          const { stream, contentType } = await streamS3Object(objectKeyFromUrl);

          const isThumb = req.query.thumb === '1';
          const quality = isThumb ? 70 : 85;
          const width = isThumb ? 300 : 800;

          const transformer = sharp()
            .resize(width, null, { withoutEnlargement: true })
            .jpeg({ quality, progressive: true });

          res.set({
            "Content-Type": contentType || "image/jpeg",
            "Content-Disposition": `inline; filename="${path.basename(objectKeyFromUrl) || defaultName}"`,
            "Cache-Control": "private, max-age=60",
          });

          return stream.pipe(transformer).pipe(res);
        } catch (error) {
          console.error("Direct S3 stream failed for HTTP face URL:", error);
          if (isOurBucketUrl) {
            return res.status(404).json({ error: "Face image not found" });
          }
          // else fall through to proxy fallback
        }
      }

      try {
        const proxied = await tryProxyHttp(faceEmbedding);
        if (proxied) return;
      } catch (error) {
        console.error("Error proxying face image URL:", error);
        return res.status(500).json({
          error: "Unable to fetch face image",
          details: error?.message || "Remote request failed",
        });
      }
    }

    return res.status(404).json({ error: "Face image not found" });
  } catch (error) {
    console.error("Face image streaming error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  } finally {
    finalizeRouteMetrics(routeMetrics);
  }
});

router.post("/store-face", upload.single("image"), async (req, res) => {
  const routeMetrics = createRouteMetrics("store-face", req);
  let objectKey = null;
  let normalizedUserId = null;
  let normalizedEmpId = null;
  try {
    const { userId: rawUserId, emp_id: rawEmpId, employeeId: rawEmployeeId } = req.body;

    normalizedUserId = normalizeId(rawUserId);
    normalizedEmpId = normalizeId(rawEmpId ?? rawEmployeeId);

    if (normalizedUserId === null && normalizedEmpId === null) {
      return res.status(400).json({
        error: "User or employee identifier is required",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!bucketName) {
      return res.status(500).json({
        error: "S3 bucket is not configured",
        details: "Set AWS_S3_BUCKET or S3_BUCKET_NAME in the backend environment.",
      });
    }

    const rawObjectKey = req.file.key || req.file.location;
    objectKey = parseFaceKey(rawObjectKey);

    if (!objectKey) {
      return res.status(500).json({
        error: "Error processing face data",
        details: "Unable to resolve S3 object key for uploaded face image.",
      });
    }

    const candidateEmpIds = [normalizedEmpId, normalizedUserId].filter(
      (value, index, array) => value !== null && array.indexOf(value) === index
    );

    let targetEmployeeId = null;

    let employeeRecord = null;

    for (const candidate of candidateEmpIds) {
      try {
        const result = await pool.query(
          `SELECT emp_id, face_embedding, face_id, face_confidence
             FROM employee
             WHERE emp_id = $1`,
          [candidate]
        );

        if (result.rows.length > 0) {
          employeeRecord = result.rows[0];
          targetEmployeeId = employeeRecord.emp_id;
          break;
        }
      } catch (lookupError) {
        console.error("Employee lookup error:", lookupError);
      }
    }

    if (!targetEmployeeId) {
      return res.status(404).json({
        error: "Employee not found",
        details: "Provide a valid employee identifier when storing face data.",
      });
    }


    // ---------------------------------------------------------------
    // If the employee already has a face enrolled, replace it.
    // This auto-replace strategy avoids forcing the user to manually
    // delete first, and also fixes the "group punch unrecognized" bug
    // where face_id in the DB is stale (not present in the Rekognition
    // collection).  We clean up the old artefacts before indexing.
    // ---------------------------------------------------------------
    if (employeeRecord?.face_embedding) {
      console.log(`[StoreFace] emp_id=${targetEmployeeId} already has face_embedding; replacing...`);

      // Remove old Rekognition face_id from collection
      const _collectionId = resolveCollectionId();
      if (_collectionId && employeeRecord.face_id) {
        try {
          await ensureCollectionExists(_collectionId);
          routeMetrics.rekognitionCalls += 1;
          await rekognition.send(
            new DeleteFacesCommand({
              CollectionId: _collectionId,
              FaceIds: [employeeRecord.face_id],
            })
          );
          console.log(`[StoreFace] Removed stale face_id ${employeeRecord.face_id} from collection.`);
        } catch (rekErr) {
          // Non-fatal: may already be gone
          console.warn(`[StoreFace] Could not remove old face_id ${employeeRecord.face_id}:`, rekErr.message);
        }
      }

      // Delete old S3 objects for this employee
      const _buckets = [bucketName, secondaryBucketName].filter(Boolean);
      const _oldKey = parseFaceKey(employeeRecord.face_embedding);
      const _prefixes = [
        `faces/${targetEmployeeId}/`,
        employeeRecord.emp_code ? `faces/${employeeRecord.emp_code}/` : null,
      ].filter(Boolean);

      for (const _bucket of _buckets) {
        // Delete by prefix scan
        for (const _prefix of _prefixes) {
          try {
            const _listed = await s3.send(new ListObjectsV2Command({ Bucket: _bucket, Prefix: _prefix }));
            for (const _obj of _listed?.Contents || []) {
              if (_obj.Key && _obj.Key !== objectKey) { // don't delete the new upload
                await s3.send(new DeleteObjectCommand({ Bucket: _bucket, Key: _obj.Key })).catch(() => { });
              }
            }
          } catch (_) { }
        }
        // Also explicitly delete the stored key
        if (_oldKey && _oldKey !== objectKey) {
          await s3.send(new DeleteObjectCommand({ Bucket: _bucket, Key: _oldKey })).catch(() => { });
        }
      }

      // Clear DB face fields so re-index proceeds cleanly
      await pool.query(
        `UPDATE employee SET face_embedding = NULL, face_confidence = NULL, face_id = NULL WHERE emp_id = $1`,
        [targetEmployeeId]
      );

      MISSING_FACE_CACHE.delete(targetEmployeeId);
      FOUND_FACE_CACHE.delete(targetEmployeeId);
    }

    const collectionId = resolveCollectionId();
    if (!collectionId) {
      console.error("Face processing error: Rekognition collection ID is not configured");
      return res.status(500).json({
        error: "Error processing face data",
        details:
          "AWS Rekognition collection is not configured. Set REKOGNITION_COLLECTION in the backend .env file.",
      });
    }

    await ensureCollectionExists(collectionId);

    const rekognitionParams = {
      CollectionId: collectionId,
      Image: {
        S3Object: {
          Bucket: bucketName,
          Name: objectKey,
        },
      },
      ExternalImageId: targetEmployeeId.toString(),
      DetectionAttributes: ["DEFAULT"],
      MaxFaces: 1,
      QualityFilter: "HIGH",
    };

    const command = new IndexFacesCommand(rekognitionParams);
    routeMetrics.rekognitionCalls += 1;
    const rekognitionResponse = await rekognition.send(command);

    if (
      !rekognitionResponse.FaceRecords ||
      rekognitionResponse.FaceRecords.length === 0
    ) {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      });
      await s3.send(deleteCommand);

      return res.status(400).json({
        error: "No face detected",
        details:
          rekognitionResponse.UnindexedFaces?.[0]?.Reasons?.join(", ") ||
          "Unknown reason",
      });
    }

    const faceRecord = rekognitionResponse.FaceRecords[0];
    const faceId = faceRecord.Face.FaceId;
    const confidence = faceRecord.Face.Confidence;

    const updateResult = await pool.query(
      `UPDATE employee SET
         face_embedding = $2,
         face_confidence = $3,
         face_id = $4
       WHERE emp_id = $1
       RETURNING emp_id`,
      [targetEmployeeId, objectKey, confidence, faceId]
    );

    if (updateResult.rowCount === 0) {
      throw new Error("Unable to update employee face metadata");
    }

    // Clear any stale cache entries for this employee so new image is served immediately
    MISSING_FACE_CACHE.delete(targetEmployeeId);
    FOUND_FACE_CACHE.delete(targetEmployeeId);

    res.json({
      success: true,
      faceId,
      imageUrl: req.file.location || buildPublicFaceUrl(objectKey),
      confidence,
      empId: updateResult.rows[0].emp_id,
    });
  } catch (error) {
    console.error("Face processing error:", error);

    const cleanupKey =
      objectKey || parseFaceKey(req.file?.key || req.file?.location);

    if (cleanupKey) {
      try {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: bucketName,
          Key: cleanupKey,
        });
        await s3.send(deleteCommand);
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
    }

    // Clear cache so a re-upload can take effect immediately after an error/retry
    if (normalizedEmpId) {
      MISSING_FACE_CACHE.delete(normalizedEmpId);
      FOUND_FACE_CACHE.delete(normalizedEmpId);
    }

    return res.status(500).json({
      error: "Error processing face data",
      details: error.message,
    });
  } finally {
    finalizeRouteMetrics(routeMetrics);
  }
});

router.get("/:employeeId", async (req, res) => {
  try {
    const employeeId = normalizeId(req.params.employeeId);

    if (employeeId === null) {
      return res.status(400).json({ error: "Valid employee ID is required" });
    }

    const { rows } = await pool.query(
      `SELECT emp_id, emp_code, name, face_embedding, face_confidence, face_id
         FROM employee
         WHERE emp_id = $1`,
      [employeeId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const record = rows[0];

    if (!record.face_embedding) {
      return res.status(404).json({ error: "Face image not stored for this employee" });
    }

    const objectKey = parseFaceKey(record.face_embedding);

    let s3ObjectExists = true;
    if (objectKey) {
      try {
        await s3.send(
          new HeadObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
          })
        );
      } catch (headError) {
        s3ObjectExists = false;
      }
    } else {
      s3ObjectExists = false;
    }

    let imageUrl = buildPublicFaceUrl(record.face_embedding);
    if (!imageUrl && isBackblazeUrl(record.face_embedding)) {
      imageUrl = `app/attendance/employee/faceRoutes/image/${record.emp_id}`;
    }

    return res.json({
      success: true,
      face: {
        empId: record.emp_id,
        employeeCode: record.emp_code,
        employeeName: record.name,
        key: record.face_embedding,
        imageUrl,
        confidence: record.face_confidence,
        faceId: record.face_id,
        s3ObjectExists,
      },
    });
  } catch (error) {
    console.error("Fetch face error:", error);
    res.status(500).json({ error: "Unable to fetch face details", details: error.message });
  }
});

router.delete("/:employeeId", async (req, res) => {
  try {
    const employeeId = normalizeId(req.params.employeeId);

    if (employeeId === null) {
      return res.status(400).json({ error: "Valid employee ID is required" });
    }

    if (!bucketName) {
      return res.status(500).json({
        error: "S3 bucket is not configured",
        details: "Set AWS_S3_BUCKET or S3_BUCKET_NAME in the backend environment.",
      });
    }

    const { rows } = await pool.query(
      `SELECT emp_id, emp_code, face_embedding, face_id
         FROM employee
         WHERE emp_id = $1`,
      [employeeId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const record = rows[0];

    if (!record.face_embedding && !record.face_id) {
      return res.status(404).json({ error: "No face stored for this employee" });
    }

    // ---------------------------------------------------------------
    // 1. Collect every S3 prefix where this employee's files might live
    // ---------------------------------------------------------------
    const buckets = [bucketName, secondaryBucketName].filter(Boolean);
    const prefixes = [
      `faces/${employeeId}/`,
      record.emp_code ? `faces/${record.emp_code}/` : null,
      // Legacy flat prefixes (without 'faces/' parent)
      `${employeeId}/`,
      record.emp_code ? `${record.emp_code}/` : null,
    ].filter(Boolean);

    // Keys we will delete (de-duplicated)
    const keysToDelete = new Map(); // "bucket::key" -> { bucket, key }

    // ---------------------------------------------------------------
    // 2. List all objects under every prefix in every bucket
    // ---------------------------------------------------------------
    for (const bucket of buckets) {
      for (const prefix of prefixes) {
        try {
          let continuationToken = undefined;
          do {
            const listed = await s3.send(
              new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken,
              })
            );
            for (const obj of listed?.Contents || []) {
              if (obj.Key && !obj.Key.endsWith("/")) {
                keysToDelete.set(`${bucket}::${obj.Key}`, { bucket, key: obj.Key });
              }
            }
            continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
          } while (continuationToken);
        } catch (listErr) {
          console.error(`[DeleteFace] List error (${bucket}/${prefix}):`, listErr.message);
        }
      }
    }

    // ---------------------------------------------------------------
    // 3. Also delete the exact key stored in face_embedding
    //    (it might live under a prefix not covered above)
    // ---------------------------------------------------------------
    const { parseFaceKey: _parseFaceKey } = require("../../utils/faceImage");
    const storedKey = _parseFaceKey(record.face_embedding);
    if (storedKey) {
      for (const bucket of buckets) {
        keysToDelete.set(`${bucket}::${storedKey}`, { bucket, key: storedKey });
      }
    }

    // ---------------------------------------------------------------
    // 4. Delete everything we found
    // ---------------------------------------------------------------
    for (const { bucket, key } of keysToDelete.values()) {
      try {
        await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key })
        );
        console.log(`[DeleteFace] Deleted s3://${bucket}/${key}`);
      } catch (delErr) {
        console.error(`[DeleteFace] S3 delete error (${bucket}/${key}):`, delErr.message);
      }
    }

    console.log(`[DeleteFace] emp_id=${employeeId}: deleted ${keysToDelete.size} S3 object(s).`);

    // ---------------------------------------------------------------
    // 5. Remove face from Rekognition collection
    // ---------------------------------------------------------------
    const collectionId = resolveCollectionId();
    if (collectionId && record.face_id) {
      try {
        await ensureCollectionExists(collectionId);
        await rekognition.send(
          new DeleteFacesCommand({
            CollectionId: collectionId,
            FaceIds: [record.face_id],
          })
        );
        console.log(`[DeleteFace] Removed face_id=${record.face_id} from Rekognition collection.`);
      } catch (rekognitionError) {
        console.error("[DeleteFace] Rekognition face delete error:", rekognitionError.message);
      }
    }

    // ---------------------------------------------------------------
    // 6. Clear the database record
    // ---------------------------------------------------------------
    await pool.query(
      `UPDATE employee
         SET face_embedding = NULL,
             face_confidence = NULL,
             face_id = NULL
       WHERE emp_id = $1`,
      [employeeId]
    );

    // ---------------------------------------------------------------
    // 7. Flush in-memory caches so the next upload is treated as new
    // ---------------------------------------------------------------
    MISSING_FACE_CACHE.delete(employeeId);
    FOUND_FACE_CACHE.delete(employeeId);

    return res.json({
      success: true,
      message: "Stored face removed successfully",
      deletedObjects: keysToDelete.size,
    });
  } catch (error) {
    console.error("[DeleteFace] Unexpected error:", error);
    res.status(500).json({ error: "Unable to delete stored face", details: error.message });
  }
});

module.exports = router;



