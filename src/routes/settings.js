'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const { getSettings } = require('../services/settings');

const router = express.Router();

// GET /api/settings — pricing the frontend needs to render quotes and labels.
// Available to any authenticated user (read-only).
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    res.json({
      captchaCost: s.captcha_cost,
      boostsPerToken: Number(process.env.BOOSTS_PER_TOKEN || 2),
    });
  })
);

module.exports = router;
