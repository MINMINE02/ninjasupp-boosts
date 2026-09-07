'use strict';

const express = require('express');
const { getConfig } = require('../services/config');

const router = express.Router();

// GET /api/config — public, unauthenticated client config.
router.get('/', async (req, res) => {
  let supportUrl = process.env.SUPPORT_URL || 'https://t.me/boostredeem';
  try {
    supportUrl = (await getConfig('support_server_url')) || supportUrl;
  } catch {
    // fall back to the env default
  }
  res.json({
    logoUrl: process.env.LOGO_URL || '',
    supportUrl,
  });
});

module.exports = router;
