require("dotenv").config();
const { s3, ListObjectsV2Command } = require("./config/awsConfig");
(async()=>{
  const bucket=process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  for (const id of [8956,11260,8957]) {
    const resp = await s3.send(new ListObjectsV2Command({Bucket: bucket, Prefix: `faces/${id}/`, MaxKeys: 20}));
    console.log(id, (resp.Contents||[]).map(o=>({k:o.Key,d:o.LastModified})));
  }
})();
