const express = require("express");
const router = express.Router();

/**
 * @route GET /api/app/config/version
 * @desc Get the latest app version and force update status
 */
router.get("/version", (req, res) => {
  res.set('Cache-Control','no-store');
  const {policy,platformOf}=require('../../utils/androidAppVersion');
  res.json(policy(platformOf(req)));
});

module.exports = router;
