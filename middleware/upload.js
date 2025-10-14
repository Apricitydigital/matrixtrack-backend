const multer = require("multer");
const multerS3 = require("multer-s3");
const { s3 } = require("../config/awsConfig");
require("dotenv").config();

const bucketName = process.env.AWS_S3_BUCKET || process.env.AWS_S3_BUCKET;

const upload = multer({
  storage: multerS3({
    s3,
    bucket: bucketName,
    key: (req, file, cb) => {
      const identifier =
        req.body.emp_id ||
        req.body.employeeId ||
        req.body.userId ||
        "unknown";
      cb(null, `faces/${identifier}/${Date.now()}_${file.originalname}`);
    },
  }),
});

module.exports = upload;
