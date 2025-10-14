const express = require("express");
const router = express.Router();
const {
  rekognition,
  s3,
  IndexFacesCommand,
  CreateCollectionCommand,
  DeleteFacesCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require("../../config/awsConfig");
const pool = require("../../config/db");
const upload = require("../../middleware/upload");
const { buildPublicFaceUrl, parseFaceKey } = require("../../utils/faceImage");

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

router.get("/gallery", async (req, res) => {
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

    res.json({
      success: true,
      bucket: bucketName,
      prefix,
      count: images.length,
      images,
    });
  } catch (error) {
    console.error("Face gallery fetch error:", error);
    res.status(500).json({
      error: "Unable to list face images",
      details: error.message,
    });
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

    return res.json({
      success: true,
      face: {
        empId: record.emp_id,
        employeeCode: record.emp_code,
        employeeName: record.name,
        key: record.face_embedding,
        imageUrl: buildPublicFaceUrl(record.face_embedding),
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
