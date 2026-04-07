const express = require("express");
const router = express.Router();

/**
 * @route GET /api/app/config/version
 * @desc Get the latest app version and force update status
 */
router.get("/version", (req, res) => {
  // In a real scenario, these could be stored in a database or env variables
  const versionConfig = {
    latestVersion: "1.0.0",
    minVersion: "1.0.0", // If app version is less than this, force update
    forceUpdate: true,
    updateUrl: "https://play.google.com/store/apps/details?id=com.apricitydigital.attendeaseApp",
    message: "A new version of MatrixTrack is available. Please update to continue using the application."
  };

  res.json(versionConfig);
});

module.exports = router;
