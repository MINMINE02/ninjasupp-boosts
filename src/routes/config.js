'use strict';

const express = require('express');
const { getConfig } = require('../services/config');
const branding = require('../services/branding');

const router = express.Router();

// GET /api/config — public, unauthenticated client config.
router.get('/', async (req, res) => {
  let supportUrl = process.env.SUPPORT_URL || 'https://discord.gg/ninjasupp';
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

// GET /api/config/page/:slug — public branding of a reseller's redeem page.
router.get('/page/:slug', async (req, res) => {
  try {
    const b = await branding.get(req.params.slug);
    if (!b) return res.status(404).json({ error: 'Page not found' });
    const { embed, ...pub } = b; // the embed image is only for crawlers (see /embed/r/:slug)
    res.json(pub);
  } catch {
    res.status(404).json({ error: 'Page not found' });
  }
});

module.exports = router;
