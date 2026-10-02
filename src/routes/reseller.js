'use strict';

/**
 * Reseller dashboard API (customer logged in with their normal account).
 * The admin switches an account to "reseller" in the admin panel; until then
 * /me answers { enabled: false } and everything else is refused (403).
 */

const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, parseInviteCode } = require('../utils/helpers');
const svc = require('../services/reseller');
const { syncJob } = require('./boost');
const joiner = require('../services/joiner');
const checker = require('../services/checker');
const crypto = require('crypto');
const { getSettings } = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

const COLS = 'id, username, reseller, balance, boost_price, redeem_slug, redeem_title, support_url, api_key_prefix, api_key_created_at';
const RESERVED_SLUGS = new Set(['admin', 'api', 'r', 'www', 'static', 'assets', 'login', 'app']);

async function loadReseller(userId) {
  const { data, error } = await supabase.from('users').select(COLS).eq('id', userId).maybeSingle();
  if (error) return null; // migration not run yet -> behave like "not a reseller"
  return data && data.reseller ? data : null;
}

async function requireReseller(req, res, next) {
  try {
    const r = await loadReseller(req.user.id);
    if (!r) return res.status(403).json({ error: 'Reseller access is not enabled on this account' });
    req.reseller = r;
    next();
  } catch (err) { next(err); }
}

const pageOf = (r) => ({ slug: r.redeem_slug || '', title: r.redeem_title || '', supportUrl: r.support_url || '' });

router.get('/me', asyncHandler(async (req, res) => {
  const r = await loadReseller(req.user.id);
  if (!r) return res.json({ enabled: false });
  res.json({
    enabled: true,
    username: r.username,
    balance: Number(r.balance || 0),
    boostPrice: Number(r.boost_price || 0),
    page: pageOf(r),
    api: { prefix: r.api_key_prefix || '', createdAt: r.api_key_created_at || null },
    ...(await svc.summary(r.id)),
  });
}));

router.use(requireReseller);

/* -------------------------------- stock -------------------------------- */
router.get('/stock', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('stock_tokens')
    .select('id, token, status, created_at, used_at')
    .eq('owner_id', req.reseller.id)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  const s = await svc.summary(req.reseller.id);
  res.json({
    ...s.stock,
    tokens: (data || []).map((t) => ({ id: t.id, preview: svc.maskToken(t.token), status: t.status, createdAt: t.created_at, usedAt: t.used_at })),
  });
}));

router.post('/stock', asyncHandler(async (req, res) => {
  const r = await svc.addStock(req.reseller.id, req.body?.tokens);
  res.status(201).json({
    ...r,
    message: `Added ${r.inserted} token${r.inserted === 1 ? '' : 's'}${r.duplicates ? ` · ${r.duplicates} already existed` : ''}`,
  });
}));

router.get('/stock/export', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('stock_tokens')
    .select('token, full_line')
    .eq('owner_id', req.reseller.id)
    .eq('status', 'unused')
    .order('created_at', { ascending: false })
    .limit(20000);
  if (error) throw error;
  res.json({ tokens: (data || []).map((t) => t.full_line || t.token) });
}));

router.delete('/stock', asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'used' ? 'used' : 'unused';
  const { error } = await supabase.from('stock_tokens').delete().eq('owner_id', req.reseller.id).eq('status', scope);
  if (error) throw error;
  res.json({ message: `${scope} tokens deleted` });
}));

router.delete('/stock/:id', asyncHandler(async (req, res) => {
  const { error } = await supabase.from('stock_tokens').delete().eq('id', req.params.id).eq('owner_id', req.reseller.id);
  if (error) throw error;
  res.json({ message: 'Token deleted' });
}));

/* -------------------------------- keys --------------------------------- */
router.get('/keys', asyncHandler(async (req, res) => {
  res.json({ keys: await svc.listKeys(req.reseller.id, { limit: 2000 }) });
}));

router.post('/keys', asyncHandler(async (req, res) => {
  const keys = await svc.generateKeys(req.reseller.id, req.body || {});
  res.status(201).json({ message: `Generated ${keys.length} key${keys.length === 1 ? '' : 's'}`, keys });
}));

router.delete('/keys', asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'redeemed' ? 'redeemed' : 'unused';
  let q = supabase.from('redeem_keys').delete().eq('owner_id', req.reseller.id);
  q = scope === 'unused' ? q.is('redeemed_at', null) : q.not('redeemed_at', 'is', null);
  const { error } = await q;
  if (error) throw error;
  res.json({ message: `${scope} keys deleted` });
}));

router.delete('/keys/:code', asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from('redeem_keys').delete()
    .eq('code', String(req.params.code || '').toUpperCase())
    .eq('owner_id', req.reseller.id);
  if (error) throw error;
  res.json({ message: 'Key deleted' });
}));

/* ------------------------------- orders -------------------------------- */
router.get('/orders', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('jobs').select('*')
    .eq('owner_id', req.reseller.id)
    .neq('mode', 'join')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  let jobs = data || [];

  // A job only advances when something polls it — refresh the running ones so
  // this list is accurate even if the end customer closed their tab.
  const running = jobs.filter((j) => j.status === 'running').slice(0, 10);
  if (running.length) {
    const fresh = await Promise.all(running.map((j) => syncJob(j).catch(() => j)));
    const byId = new Map(fresh.map((j) => [j.id, j]));
    jobs = jobs.map((j) => byId.get(j.id) || j);
  }

  const keyIds = [...new Set(jobs.map((j) => j.key_id).filter(Boolean))];
  let codes = {};
  if (keyIds.length) {
    const { data: ks } = await supabase.from('redeem_keys').select('id, code').in('id', keyIds);
    codes = Object.fromEntries((ks || []).map((k) => [k.id, k.code]));
  }
  res.json({
    orders: jobs.map((j) => ({
      id: j.id, key: codes[j.key_id] || null, server: j.invite, status: j.status,
      requested: j.boosts_requested, delivered: j.boosts_delivered, tokens: j.tokens_used,
      createdAt: j.created_at, updatedAt: j.updated_at,
    })),
  });
}));

/* ------------------------------- joiner -------------------------------- */
const INVITE_RE = /^[A-Za-z0-9-]{2,32}$/;

router.get('/joiner', asyncHandler(async (req, res) => {
  const [{ data, error }, s, settings] = await Promise.all([
    supabase.from('jobs').select('*').eq('owner_id', req.reseller.id).eq('mode', 'join')
      .order('created_at', { ascending: false }).limit(15),
    svc.summary(req.reseller.id),
    getSettings(),
  ]);
  if (error) throw error;
  let jobs = data || [];
  const running = jobs.filter((j) => j.status === 'running').slice(0, 3);
  if (running.length) {
    const fresh = await Promise.all(running.map((j) => joiner.syncJoin(j).catch(() => j)));
    const byId = new Map(fresh.map((j) => [j.id, j]));
    jobs = jobs.map((j) => byId.get(j.id) || j);
  }
  const { data: u } = await supabase.from('users').select('balance').eq('id', req.reseller.id).maybeSingle();
  res.json({
    stockUnused: s.stock.unused,
    maxPerJoin: joiner.MAX_JOIN,
    captchaCost: Number(settings.captcha_cost) || 0,
    balance: Number(u?.balance || 0),
    jobs: jobs.map((j) => joiner.mapJoin(j)),
  });
}));

// Accept a Discord invite URL or a bare code — never free text (the shared
// parser would otherwise keep just the first word of "hello there").
function cleanInvite(value) {
  const text = String(value || '').trim();
  const isUrl = /(?:discord\.gg|discord(?:app)?\.com\/invite)\//i.test(text);
  if (!isUrl && /\s/.test(text)) return null;
  const code = parseInviteCode(text);
  return INVITE_RE.test(code) ? code : null;
}

router.post('/joiner', asyncHandler(async (req, res) => {
  const invite = cleanInvite(req.body?.invite);
  if (!invite) return res.status(400).json({ error: 'A valid Discord invite link or code is required' });
  const r = await joiner.startJoin(req.reseller, invite, req.body?.count);
  res.status(201).json({ message: `Joining ${r.job.requested} accounts to ${invite}`, ...r });
}));

router.get('/joiner/:id', asyncHandler(async (req, res) => {
  const { data: job } = await supabase.from('jobs').select('*')
    .eq('id', req.params.id).eq('owner_id', req.reseller.id).eq('mode', 'join').maybeSingle();
  if (!job) return res.status(404).json({ error: 'Join not found' });
  res.json({ job: joiner.mapJoin(await joiner.syncJoin(job), { items: true }) });
}));

/* ------------------------------ checker -------------------------------- */
router.get('/stock/check', asyncHandler(async (req, res) => {
  res.json({ check: await checker.latest(req.reseller.id), max: checker.MAX_CHECK });
}));
router.post('/stock/check', asyncHandler(async (req, res) => {
  const check = await checker.startCheck(req.reseller.id);
  res.status(201).json({ message: `Checking ${check.submitted} tokens`, check });
}));
router.get('/stock/check/:id', asyncHandler(async (req, res) => {
  res.json({ check: await checker.pollCheck(req.reseller.id, req.params.id) });
}));
router.get('/stock/check/:id/results', asyncHandler(async (req, res) => {
  res.json(await checker.results(req.reseller.id, req.params.id));
}));
router.post('/stock/check/:id/purge', asyncHandler(async (req, res) => {
  const r = await checker.purge(req.reseller.id, req.params.id, req.body?.statuses);
  res.json({ message: `${r.deleted} token${r.deleted === 1 ? '' : 's'} deleted`, ...r });
}));

/* ------------------------- SellAuth dynamic delivery -------------------- */
// Each reseller gets a private webhook (/api/sellauth/r/<ref>) with their own
// secret, product links and delivery log. Keys land in THEIR key list.
const newRef = () => crypto.randomBytes(12).toString('hex');   // 24 hex chars, unguessable

router.get('/sellauth', asyncHandler(async (req, res) => {
  const id = req.reseller.id;
  const [{ data: u, error: uErr }, { data: products, error: pErr }, { data: deliveries, error: dErr }] = await Promise.all([
    supabase.from('users').select('sellauth_ref, sellauth_secret, sellauth_default_boosts').eq('id', id).maybeSingle(),
    supabase.from('sellauth_products').select('id, sellauth_id, label, boosts_value').eq('owner_id', id).order('created_at', { ascending: false }),
    supabase.from('sellauth_deliveries')
      .select('id, invoice_id, product_name, boosts_value, key_code, server_link, status, error, payload, created_at')
      .eq('owner_id', id).order('created_at', { ascending: false }).limit(50),
  ]);
  const schemaMissing = (err) => err && /schema cache|does not exist|could not find the/i.test(err.message || '');
  if (schemaMissing(uErr) || schemaMissing(pErr) || schemaMissing(dErr)) {
    return res.status(503).json({
      error: 'SellAuth columns/tables are missing. Run db/migration_resellers.sql (or db/migration_sellauth_users.sql) in the Supabase SQL editor.',
      ref: null, secretSet: false, defaultBoosts: 0, products: [], deliveries: [],
    });
  }
  if (uErr) throw uErr;
  if (pErr) throw pErr;
  if (dErr) throw dErr;
  res.json({
    ref: u?.sellauth_ref || null,
    secretSet: Boolean(u?.sellauth_secret),
    defaultBoosts: Number(u?.sellauth_default_boosts) || 0,
    products: (products || []).map((p) => ({ id: p.id, sellauthId: p.sellauth_id, label: p.label || '', boosts: p.boosts_value })),
    deliveries: (deliveries || []).map((d) => ({
      id: d.id, invoiceId: d.invoice_id, product: d.product_name, boosts: d.boosts_value, key: d.key_code,
      serverLink: d.server_link || '', status: d.status, error: d.error,
      payload: d.status === 'error' ? d.payload : undefined, createdAt: d.created_at,
    })),
  });
}));

// Create the private webhook address (or rotate it: the old one stops working).
router.post('/sellauth/enable', asyncHandler(async (req, res) => {
  for (let i = 0; i < 5; i += 1) {
    const ref = newRef();
    const { error } = await supabase.from('users').update({ sellauth_ref: ref }).eq('id', req.reseller.id);
    if (!error) return res.json({ ref, message: 'Webhook address created' });
    if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  throw new Error('Could not create a webhook address');
}));

router.patch('/sellauth', asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body?.webhookSecret !== undefined) {
    const secret = String(req.body.webhookSecret || '').trim();
    if (secret && secret.length < 8) return res.status(400).json({ error: 'Webhook secret looks too short' });
    patch.sellauth_secret = secret || null;
  }
  if (req.body?.defaultBoosts !== undefined) {
    const n = Number(req.body.defaultBoosts || 0);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(400).json({ error: 'Fallback boosts must be a whole number' });
    patch.sellauth_default_boosts = n;
  }
  if (Object.keys(patch).length) {
    const { error } = await supabase.from('users').update(patch).eq('id', req.reseller.id);
    if (error) throw error;
  }
  res.json({ message: 'SellAuth settings saved' });
}));

router.post('/sellauth/products', asyncHandler(async (req, res) => {
  const sellauthId = String(req.body?.sellauthId || '').trim().slice(0, 64);
  const boosts = Number(req.body?.boosts);
  const label = String(req.body?.label || '').trim().slice(0, 80);
  if (!sellauthId) return res.status(400).json({ error: 'SellAuth product or variant ID is required' });
  if (!Number.isInteger(boosts) || boosts < 1 || boosts > 1000) return res.status(400).json({ error: 'Boosts must be a positive whole number' });
  const { data: found } = await supabase.from('sellauth_products').select('id')
    .eq('owner_id', req.reseller.id).eq('sellauth_id', sellauthId).maybeSingle();
  const { error } = found
    ? await supabase.from('sellauth_products').update({ label, boosts_value: boosts }).eq('id', found.id).eq('owner_id', req.reseller.id)
    : await supabase.from('sellauth_products').insert({ owner_id: req.reseller.id, sellauth_id: sellauthId, label, boosts_value: boosts });
  if (error) throw error;
  res.status(201).json({ message: 'Product linked' });
}));

router.delete('/sellauth/products/:id', asyncHandler(async (req, res) => {
  const { error } = await supabase.from('sellauth_products').delete().eq('id', req.params.id).eq('owner_id', req.reseller.id);
  if (error) throw error;
  res.json({ message: 'Link removed' });
}));

/* ------------------------------ API key -------------------------------- */
router.post('/api-key', asyncHandler(async (req, res) => {
  const k = svc.newApiKey();
  const { error } = await supabase
    .from('users')
    .update({ api_key_hash: k.hash, api_key_prefix: k.prefix, api_key_created_at: new Date().toISOString() })
    .eq('id', req.reseller.id);
  if (error) throw error;
  // The full key is shown exactly once — only its hash is stored.
  res.status(201).json({ key: k.key, prefix: k.prefix, message: 'New API key created — copy it now, it will not be shown again' });
}));

router.delete('/api-key', asyncHandler(async (req, res) => {
  const { error } = await supabase
    .from('users')
    .update({ api_key_hash: null, api_key_prefix: null, api_key_created_at: null })
    .eq('id', req.reseller.id);
  if (error) throw error;
  res.json({ message: 'API key revoked' });
}));

/* ---------------------------- redeem page ------------------------------ */
router.patch('/page', asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body?.slug !== undefined) {
    const slug = String(req.body.slug || '').trim().toLowerCase();
    if (slug && (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || RESERVED_SLUGS.has(slug))) {
      return res.status(400).json({ error: 'Page name: 3–32 characters, letters, numbers and dashes (not starting or ending with a dash)' });
    }
    patch.redeem_slug = slug || null;
  }
  if (req.body?.title !== undefined) patch.redeem_title = String(req.body.title || '').trim().slice(0, 40) || null;
  if (req.body?.supportUrl !== undefined) {
    const url = String(req.body.supportUrl || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Support link must start with http(s)://' });
    patch.support_url = url || null;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  const { error } = await supabase.from('users').update(patch).eq('id', req.reseller.id);
  if (error) {
    if (/duplicate|unique/i.test(error.message || '')) return res.status(409).json({ error: 'That page name is already taken' });
    throw error;
  }
  res.json({ message: 'Redeem page saved', page: { slug: patch.redeem_slug ?? req.reseller.redeem_slug ?? '', title: patch.redeem_title ?? req.reseller.redeem_title ?? '', supportUrl: patch.support_url ?? req.reseller.support_url ?? '' } });
}));

module.exports = router;
