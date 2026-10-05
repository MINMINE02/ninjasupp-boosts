'use strict';

// External "pinger" endpoint that advances direct SellAuth boosts on hosts
// without timers (Vercel). Protect it with CRON_SECRET:
//   GET /api/cron/sync?secret=<CRON_SECRET>      or      Authorization: Bearer <CRON_SECRET>
// (Vercel Cron sends the Authorization header by itself when CRON_SECRET is set.)

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../utils/helpers');
const jobDriver = require('../services/jobDriver');

const router = express.Router();

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

router.all('/sync', asyncHandler(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set on the server' });
  const bearer = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const given = bearer || String(req.query.secret || '');
  if (!given || !same(given, secret)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(await jobDriver.syncDirectJobs());
}));

module.exports = router;
