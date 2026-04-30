require('dotenv').config({ path: '../.env' });
const pool = require('../config/db');
const { RekognitionClient, DeleteFacesCommand } = require('@aws-sdk/client-rekognition');

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function clearFace() {
  try {
    const res = await pool.query("SELECT emp_id, name, face_id FROM employee WHERE name ILIKE '%divyesh%' OR name ILIKE '%girase%'");
    
    for (const emp of res.rows) {
      if (emp.face_id) {
        console.log(`Clearing face for ${emp.name} (emp_id: ${emp.emp_id}, face_id: ${emp.face_id})`);
        
        try {
           await rekognition.send(
            new DeleteFacesCommand({
              CollectionId: process.env.REKOGNITION_COLLECTION || 'attendease_faces_collection',
              FaceIds: [emp.face_id],
            })
          );
          console.log(`Deleted face from Rekognition collection.`);
        } catch (e) {
          console.log("Error deleting from Rekognition (might already be gone):", e.message);
        }

        await pool.query(
          "UPDATE employee SET face_embedding = NULL, face_id = NULL, face_confidence = NULL WHERE emp_id = $1",
          [emp.emp_id]
        );
        console.log(`Cleared face data from database for ${emp.name}.`);
      } else {
        console.log(`No face data found for ${emp.name}.`);
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    pool.end();
  }
}

clearFace();
