const { rekognition, s3 } = require("../config/awsConfig");
const { SearchFacesByImageCommand } = require("@aws-sdk/client-rekognition");
const pool = require("../config/db");

const faceVerify = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    // Search for face in collection
    const searchParams = {
      CollectionId: process.env.REKOGNITION_COLLECTION,
      Image: {
        Bytes: req.file.buffer,
      },
      MaxFaces: 1,
      FaceMatchThreshold: 90,
    };

    const command = new SearchFacesByImageCommand(searchParams);
    const result = await rekognition.send(command);

    if (!result.FaceMatches || result.FaceMatches.length === 0) {
      return res.status(401).json({ error: "No matching face found" });
    }

    // Get the matched face ID
    const matchedFaceId = result.FaceMatches[0].Face.FaceId;

    // Find employee with this faceId
    const { rows } = await pool.query(
      "SELECT emp_id FROM employee WHERE face_id = $1",
      [matchedFaceId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Employee not registered" });
    }

    // Attach employee ID to request for the next middleware
    req.employeeId = rows[0].emp_id;
    next();
  } catch (error) {
    console.error("Face verification error:", error);
    res
      .status(500)
      .json({ error: "Face verification failed", details: error.message });
  }
};

module.exports = faceVerify;
