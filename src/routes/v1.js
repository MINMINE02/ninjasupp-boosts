'use strict';

/**
 * Public reseller API — authenticated with an API key (created in the
 * customer dashboard → API), for scripts and other shops:
 *
 *   Authorization: Bearer nbk_xxxxxxxx      (or X-API-Key: nbk_xxxxxxxx)
 */

const express = require('express');
const supabase = require('../config/supabase');
const { asyncHandler } = require('../utils/helpers');
const svc = require('../services/reseller');

const router = express.Router();

router.use(asyncHandler(async (req, res, next) => {
  const header = req.get('Authorization') || '';
  const raw = (header.startsWith('Bearer ') ? header.slice(7) : req.get('X-API-Key') || '').trim();
  if (!raw.startsWith('nbk_')) return res.status(401).json({ error: 'Missing or invalid API key' });

  const { data: user } = await supabase
    .from('users')
    .select('id, username, reseller, balance, boost_price')
    .eq('api_key_hash', svc.hashApiKey(raw))
    .maybeSingle();
  if (!user) return res.status(401).json({ error: 'Missing or invalid API key' });
  if (!user.reseller) return res.status(403).json({ error: 'Reseller access is disabled for this account' });
  req.reseller = user;
  next();
}));

router.get('/me', asyncHandler(async (req, res) => {
  const s = await svc.summary(req.reseller.id);
  res.json({ username: req.reseller.username, balance: Number(req.reseller.balance || 0), boostPrice: Number(req.reseller.boost_price || 0), ...s });
}));

router.get('/stock', asyncHandler(async (req, res) => {
  res.json((await svc.summary(req.reseller.id)).stock);
}));

router.post('/stock', asyncHandler(async (req, res) => {
  res.status(201).json(await svc.addStock(req.reseller.id, req.body?.tokens));
}));

router.post('/keys', asyncHandler(async (req, res) => {
  const keys = await svc.generateKeys(req.reseller.id, req.body || {});
  res.status(201).json({ keys });
}));

router.get('/keys', asyncHandler(async (req, res) => {
  const status = ['unused', 'redeemed'].includes(req.query.status) ? req.query.status : undefined;
  res.json({ keys: await svc.listKeys(req.reseller.id, { status, limit: req.query.limit }) });
}));

router.get('/keys/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const { data } = await supabase
    .from('redeem_keys')
    .select('code, boosts_value, boosts_delivered, redeemed_at, redeemed_invite, created_at')
    .eq('code', code).eq('owner_id', req.reseller.id).maybeSingle();
  if (!data) return res.status(404).json({ error: 'Key not found' });
  res.json({ code: data.code, boosts: data.boosts_value, delivered: data.boosts_delivered || 0, redeemed: Boolean(data.redeemed_at), server: data.redeemed_invite || null, createdAt: data.created_at });
}));

router.delete('/keys/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const { data } = await supabase
    .from('redeem_keys').delete()
    .eq('code', code).eq('owner_id', req.reseller.id).is('redeemed_at', null)
    .select('id');
  if (!data || !data.length) return res.status(404).json({ error: 'Unused key not found' });
  res.json({ deleted: true });
}));

module.exports = router;
