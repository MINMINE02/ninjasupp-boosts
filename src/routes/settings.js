'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const { getSettings } = require('../services/settings');
const premium = require('../services/premium');

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

// GET /api/settings/premium — content of the "Premium" tab (video, title, text).
// Any signed-in account can read it; the dashboard shows the tab to accounts
// that do not have premium yet.
router.get(
  '/premium',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await premium.getPublic());
  })
);

module.exports = router;
