const express = require("express");
const router = express.Router();

/**
 * @route GET /api/app/config/version
 * @desc Get the latest app version and force update status
 */
router.get("/version", (req, res) => {
  // In a real scenario, these could be stored in a database or env variables
  const versionConfig = {
    latestVersion: "1.0.9",
    minVersion: "1.0.0", // Disable force update for older versions by setting to 1.0.0
    forceUpdate: false,  // Set to false to prevent blocking customers
    updateUrl: "https://play.google.com/store/apps/details?id=com.apricitydigital.attendeaseApp",
    message: "A new version of MatrixTrack is available. Please update to continue using the application."
  };

  res.json(versionConfig);
});

module.exports = router;
