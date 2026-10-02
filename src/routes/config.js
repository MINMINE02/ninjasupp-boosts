'use strict';

const express = require('express');
const { getConfig } = require('../services/config');
const supabase = require('../config/supabase');

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
    const slug = String(req.params.slug || '').toLowerCase();
    const { data } = await supabase
      .from('users')
      .select('redeem_title, support_url, reseller')
      .eq('redeem_slug', slug)
      .maybeSingle();
    if (!data || !data.reseller) return res.status(404).json({ error: 'Page not found' });
    res.json({ title: data.redeem_title || '', supportUrl: data.support_url || '' });
  } catch {
    res.status(404).json({ error: 'Page not found' });
  }
});

module.exports = router;
