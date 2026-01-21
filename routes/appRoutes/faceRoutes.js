const express = require("express");
const router = express.Router();
const axios = require("axios");
const path = require("path");
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

const bucketName =
  process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME || null;
const DEFAULT_FACE_PREFIX = "faces/";

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
  if (!embedding) {
    return null;
  }

  let faceImageUrl = buildPublicFaceUrl(embedding);
  if (!faceImageUrl && isBackblazeUrl(embedding) && empId) {
    faceImageUrl = `app/attendance/employee/faceRoutes/image/${empId}`;
  } else if (!faceImageUrl && typeof embedding === "string") {
    faceImageUrl = embedding;
  }

  return faceImageUrl;
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
        JOIN supervisor_ward sw ON sw.ward_id = e.ward_id
        LEFT JOIN wards w ON e.ward_id = w.ward_id
        LEFT JOIN zones z ON w.zone_id = z.zone_id
        LEFT JOIN cities c ON z.city_id = c.city_id
       WHERE sw.supervisor_id = $1
         AND ($2::int IS NULL OR w.ward_id = $2::int)
         AND (e.face_embedding IS NOT NULL OR e.face_id IS NOT NULL)
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

const streamS3Object = async (key) => {
  if (!bucketName) {
    throw new Error("S3 bucket is not configured");
  }

  const command = new GetObjectCommand({
    Bucket: bucketName,
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

router.get("/gallery", async (req, res) => {
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
          url: buildPublicFaceUrl(item.Key),
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
  try {
    const employeeId = normalizeId(req.params.employeeId);

    if (employeeId === null) {
      return res.status(400).json({ error: "Valid employee ID is required" });
    }

    const { rows } = await pool.query(
      `SELECT face_embedding
         FROM employee
         WHERE emp_id = $1`,
      [employeeId]
    );

    if (!rows.length || !rows[0].face_embedding) {
      return res.status(404).json({ error: "Face image not stored for this employee" });
    }

    const faceEmbedding = rows[0].face_embedding;
    const defaultName = `employee_${employeeId}_face.jpg`;

    const tryProxyHttp = async (url, name = defaultName) => {
      if (!url) return false;
      const imageResponse = await axios.get(url, {
        responseType: "stream",
      });

      res.set({
        "Content-Type": imageResponse.headers["content-type"] || "image/jpeg",
        "Content-Disposition": `inline; filename="${path.basename(name) || defaultName}"`,
      });

      imageResponse.data.pipe(res);
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

          res.set({
            "Content-Type": contentType,
            "Content-Disposition": `inline; filename="${path.basename(reference.key) || defaultName}"`,
          });

          return stream.pipe(res);
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

        res.set({
          "Content-Type":
            imageResponse.headers["content-type"] || "image/jpeg",
          "Content-Disposition": `inline; filename="${path.basename(reference.key) || defaultName}"`,
        });

        return imageResponse.data.pipe(res);
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

    const objectKey = parseFaceKey(faceEmbedding);
    if (objectKey) {
      try {
        const { stream, contentType } = await streamS3Object(objectKey);

        res.set({
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${path.basename(objectKey) || defaultName}"`,
        });

        return stream.pipe(res);
      } catch (error) {
        console.error("Error streaming S3 face image:", error);
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
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/store-face", upload.single("image"), async (req, res) => {
  let objectKey = null;
  try {
    const { userId: rawUserId, emp_id: rawEmpId, employeeId: rawEmployeeId } = req.body;

    const normalizedUserId = normalizeId(rawUserId);
    const normalizedEmpId = normalizeId(rawEmpId ?? rawEmployeeId);

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

    if (employeeRecord?.face_embedding) {
      return res.status(409).json({
        error: "Face already exists",
        details: "Delete the existing face before uploading a new one.",
        face: {
          key: employeeRecord.face_embedding,
          faceId: employeeRecord.face_id,
          confidence: employeeRecord.face_confidence,
          imageUrl: buildPublicFaceUrl(employeeRecord.face_embedding),
        },
      });
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

    res.status(500).json({
      error: "Error processing face data",
      details: error.message,
    });
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
      `SELECT emp_id, face_embedding, face_id
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

    const objectKey = parseFaceKey(record.face_embedding);

    if (objectKey) {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
          })
        );
      } catch (s3Error) {
        console.error("Face delete S3 error:", s3Error);
      }
    }

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
      } catch (rekognitionError) {
        console.error("Rekognition face delete error:", rekognitionError);
      }
    }

    await pool.query(
      `UPDATE employee
         SET face_embedding = NULL,
             face_confidence = NULL,
             face_id = NULL
       WHERE emp_id = $1`,
      [employeeId]
    );

    return res.json({
      success: true,
      message: "Stored face removed successfully",
    });
  } catch (error) {
    console.error("Face delete error:", error);
    res.status(500).json({ error: "Unable to delete stored face", details: error.message });
  }
});

module.exports = router;
