'use strict';

/* =========================================================================
 * Admin tools — everything the admin needs to SEE and DO beyond the basics:
 * global search, full account sheets (users + resellers), deposits, job
 * detail, insights, system health and an activity log.
 *
 * Mounted inside routes/admin.js AFTER the admin + panel-password gates, so
 * every route here already requires both. Nothing here ever returns password
 * hashes, API key hashes or raw stock tokens.
 * ========================================================================= */

const os = require('os');
const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { asyncHandler, generateKeyCode } = require('../utils/helpers');
const E = require('../services/embed');
const siteEmbed = require('../services/siteEmbed');
const alerts = require('../services/alerts');

const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(['admin', 'api', 'r', 'www', 'static', 'assets', 'login', 'app']);
const MISSING = /schema cache|does not exist|could not find|column|relation/i;
const MIGRATION_HINT = 'Run db/migration_admin_tools.sql in Supabase first (adds suspension, notes and the activity log).';

const head = { count: 'exact', head: true };
const num = (n) => Number(n || 0);
// Strip characters that have a meaning inside a PostgREST filter value.
const clean = (s) => String(s || '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 60);
const mask = (t) => {
  t = String(t || '');
  const n = Math.max(6, Math.ceil(t.length / 2));
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};
const countOf = async (q) => {
  const { count, error } = await q;
  return error ? null : count || 0;
};
async function usernamesById(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  const { data } = await supabase.from('users').select('id, username').in('id', uniq);
  return Object.fromEntries((data || []).map((u) => [u.id, u.username]));
}
const mustUuid = (req, res) => {
  if (UUID.test(req.params.id)) return true;
  res.status(400).json({ error: 'Invalid id' });
  return false;
};

/* ---------------------------- activity log ------------------------------ */
// Every state-changing admin request is recorded (who / what / result). Only
// the NAMES of the fields sent are stored, plus a few harmless numbers —
// never passwords, tokens or keys. Silently skipped until the migration ran.
const SAFE_VALUES = ['amount', 'boostPrice', 'enabled', 'disabled', 'count', 'boostsPerKey', 'scope', 'status', 'boosts'];
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const parts = Object.keys(body).filter((k) => !SAFE_VALUES.includes(k)).slice(0, 8);
    const vals = SAFE_VALUES.filter((k) => body[k] !== undefined).map((k) => `${k}=${String(body[k]).slice(0, 24)}`);
    const q = req.query && req.query.scope ? [`scope=${String(req.query.scope).slice(0, 12)}`] : [];
    const summary = [...vals, ...q, parts.length ? `fields: ${parts.join(', ')}` : ''].filter(Boolean).join(' · ').slice(0, 240) || null;
    supabase.from('admin_audit').insert({
      admin_id: req.user?.id || null,
      admin_name: req.user?.username || null,
      method: req.method,
      path: req.originalUrl.split('?')[0].replace(/^\/api\/admin/, '').slice(0, 200),
      status: res.statusCode,
      summary,
    }).then(() => {}, () => {});
  });
  next();
});

router.get('/audit', asyncHandler(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const { data, error } = await supabase.from('admin_audit').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) {
    if (MISSING.test(error.message || '')) return res.json({ entries: [], missing: true, hint: MIGRATION_HINT });
    throw error;
  }
  res.json({
    entries: (data || []).map((a) => ({
      id: a.id, admin: a.admin_name || '—', method: a.method, path: a.path, status: a.status, summary: a.summary || '', at: a.created_at,
    })),
  });
}));

/* ------------------------------ global search --------------------------- */
router.get('/search', asyncHandler(async (req, res) => {
  const q = clean(req.query.q);
  if (q.length < 2) return res.json({ users: [], keys: [], jobs: [], pages: [] });
  const [users, pages, keys, jobs] = await Promise.all([
    supabase.from('users').select('id, username, role, reseller').ilike('username', `%${q}%`).limit(8),
    supabase.from('users').select('id, username, redeem_slug').ilike('redeem_slug', `%${q}%`).limit(6),
    supabase.from('redeem_keys').select('code, boosts_value, redeemed_at, owner_id').ilike('code', `%${q.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`).limit(8),
    UUID.test(q)
      ? supabase.from('jobs').select('id, invite, status, mode').eq('id', q).limit(1)
      : supabase.from('jobs').select('id, invite, status, mode').ilike('invite', `%${q}%`).order('created_at', { ascending: false }).limit(8),
  ]);
  const owners = await usernamesById((keys.data || []).map((k) => k.owner_id));
  res.json({
    users: (users.data || []).map((u) => ({ id: u.id, username: u.username, role: u.role, reseller: Boolean(u.reseller) })),
    pages: (pages.data || []).map((u) => ({ id: u.id, username: u.username, slug: u.redeem_slug })),
    keys: (keys.data || []).map((k) => ({ code: k.code, boosts: k.boosts_value, redeemed: Boolean(k.redeemed_at), owner: k.owner_id ? owners[k.owner_id] || 'reseller' : null })),
    jobs: (jobs.data || []).map((j) => ({ id: j.id, invite: j.invite, status: j.status, mode: j.mode })),
  });
}));

/* ------------------------------ account sheet --------------------------- */
router.get('/users/:id', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const id = req.params.id;
  const { data: u, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!u) return res.status(404).json({ error: 'Account not found' });

  const [jobs, deposits, keys, stock, deliveries, jobTotals, keyTotals] = await Promise.all([
    supabase.from('jobs')
      .select('id, mode, invite, status, boosts_requested, boosts_delivered, tokens_used, cost, created_at, user_id, owner_id, redeem_keys(code)')
      .or(`user_id.eq.${id},owner_id.eq.${id}`).order('created_at', { ascending: false }).limit(40),
    supabase.from('deposits').select('id, currency, usd_amount, received, status, tx_id, created_at, completed_at').eq('user_id', id).order('created_at', { ascending: false }).limit(30),
    u.reseller
      ? supabase.from('redeem_keys').select('code, boosts_value, boosts_delivered, redeemed_at, redeemed_invite, created_at, source, note').eq('owner_id', id).order('created_at', { ascending: false }).limit(300)
      : Promise.resolve({ data: [] }),
    u.reseller ? supabase.from('stock_tokens').select('status').eq('owner_id', id).limit(100000) : Promise.resolve({ data: [] }),
    u.reseller ? supabase.from('sellauth_deliveries').select('id, status, boosts, created_at').eq('owner_id', id).order('created_at', { ascending: false }).limit(30) : Promise.resolve({ data: [] }),
    supabase.from('jobs').select('boosts_delivered, mode, status').or(`user_id.eq.${id},owner_id.eq.${id}`).limit(50000),
    u.reseller ? supabase.from('redeem_keys').select('redeemed_at').eq('owner_id', id).limit(100000) : Promise.resolve({ data: [] }),
  ]);

  const allJobs = jobTotals.data || [];
  const stk = stock.data || [];
  res.json({
    profile: {
      id: u.id, username: u.username, role: u.role, balance: num(u.balance), createdAt: u.created_at,
      reseller: Boolean(u.reseller), boostPrice: num(u.boost_price),
      disabled: Boolean(u.disabled), note: u.admin_note || '',
      apiKey: u.api_key_prefix || '', apiKeyCreatedAt: u.api_key_created_at || null,
      sellauth: Boolean(u.sellauth_ref && u.sellauth_secret),
      page: {
        slug: u.redeem_slug || '', title: u.redeem_title || '', brand: u.redeem_brand || '',
        color: u.redeem_color || '', hasIcon: Boolean(u.redeem_icon), icon: u.redeem_icon || '', supportUrl: u.support_url || '',
        embedTitle: u.embed_title || '', embedDesc: u.embed_desc || '', embedColor: u.embed_color || '',
        hasEmbedImage: Boolean(u.embed_image), embedImage: u.embed_image || '',
      },
    },
    stats: {
      jobs: allJobs.length,
      boosts: allJobs.filter((j) => j.mode !== 'join').reduce((n, j) => n + num(j.boosts_delivered), 0),
      failed: allJobs.filter((j) => j.status === 'failed').length,
      depositsUsd: (deposits.data || []).filter((d) => d.status === 'completed').reduce((n, d) => n + num(d.usd_amount), 0),
      stockUnused: stk.filter((t) => t.status === 'unused').length,
      stockUsed: stk.filter((t) => t.status === 'used').length,
      keysTotal: (keyTotals.data || []).length,
      keysUnused: (keyTotals.data || []).filter((k) => !k.redeemed_at).length,
    },
    jobs: (jobs.data || []).map((j) => ({
      id: j.id, mode: j.mode, invite: j.invite, status: j.status, requested: j.boosts_requested, delivered: j.boosts_delivered,
      tokens: j.tokens_used, cost: num(j.cost), createdAt: j.created_at, key: j.redeem_keys?.code || null, asOwner: j.owner_id === id,
    })),
    deposits: (deposits.data || []).map((d) => ({
      id: d.id, currency: d.currency, usd: num(d.usd_amount), received: num(d.received), status: d.status, tx: d.tx_id || '', createdAt: d.created_at, completedAt: d.completed_at,
    })),
    keys: (keys.data || []).map((k) => ({
      code: k.code, boosts: k.boosts_value, delivered: k.boosts_delivered || 0, redeemed: Boolean(k.redeemed_at), redeemedAt: k.redeemed_at,
      invite: k.redeemed_invite || '', source: k.source || 'admin', note: k.note || '', createdAt: k.created_at,
    })),
    deliveries: (deliveries.data || []).map((d) => ({ id: d.id, status: d.status, boosts: d.boosts, createdAt: d.created_at })),
  });
}));

router.patch('/users/:id/password', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const password = String(req.body?.password || '');
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters' });
  const { data: u } = await supabase.from('users').select('id, username, role').eq('id', req.params.id).maybeSingle();
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Use “change credentials” for the admin account itself' });
  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from('users').update({ password_hash }).eq('id', u.id);
  if (error) throw error;
  res.json({ message: `Password of ${u.username} changed` });
}));

router.patch('/users/:id/disabled', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const disabled = Boolean(req.body?.disabled);
  const { data: u } = await supabase.from('users').select('id, username, role').eq('id', req.params.id).maybeSingle();
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'The admin account cannot be suspended' });
  const { error } = await supabase.from('users').update({ disabled }).eq('id', u.id);
  if (error) {
    if (MISSING.test(error.message || '')) return res.status(500).json({ error: MIGRATION_HINT });
    throw error;
  }
  res.json({ message: `${u.username} ${disabled ? 'suspended — can no longer sign in' : 'reactivated'}` });
}));

router.patch('/users/:id/note', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
  const { error } = await supabase.from('users').update({ admin_note: note }).eq('id', req.params.id);
  if (error) {
    if (MISSING.test(error.message || '')) return res.status(500).json({ error: MIGRATION_HINT });
    throw error;
  }
  res.json({ message: 'Note saved' });
}));

// The admin edits a reseller's redeem page (name, title, header name, colour,
// support link, icon removal) — same rules as the reseller's own editor.
router.patch('/users/:id/page', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const { data: u } = await supabase.from('users').select('id, username, reseller').eq('id', req.params.id).maybeSingle();
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (!u.reseller) return res.status(400).json({ error: 'This account is not premium' });

  const b = req.body || {};
  const patch = {};
  if (b.slug !== undefined) {
    const slug = String(b.slug || '').trim().toLowerCase();
    if (slug && (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || RESERVED_SLUGS.has(slug))) {
      return res.status(400).json({ error: 'Page name: 3–32 letters, numbers or dashes (not a reserved word)' });
    }
    patch.redeem_slug = slug || null;
  }
  if (b.title !== undefined) patch.redeem_title = String(b.title || '').trim().slice(0, 40) || null;
  if (b.brand !== undefined) patch.redeem_brand = String(b.brand || '').trim().slice(0, 30) || null;
  if (b.color !== undefined) {
    const c = String(b.color || '').trim();
    if (c && !/^#[0-9a-f]{6}$/i.test(c)) return res.status(400).json({ error: 'Colour must look like #3b82f6' });
    patch.redeem_color = c ? c.toLowerCase() : null;
  }
  if (b.supportUrl !== undefined) {
    const s = String(b.supportUrl || '').trim();
    if (s && !/^https?:\/\/[^\s"'<>]{3,300}$/i.test(s)) return res.status(400).json({ error: 'Support link must start with http(s)://' });
    patch.support_url = s || null;
  }
  if (b.clearIcon) patch.redeem_icon = null;
  if (b.embedTitle !== undefined) patch.embed_title = E.text(b.embedTitle, E.LIMITS.title) || null;
  if (b.embedDesc !== undefined) patch.embed_desc = E.text(b.embedDesc, E.LIMITS.description) || null;
  if (b.embedColor !== undefined) {
    const raw = String(b.embedColor || '').trim();
    const c = E.colour(raw);
    if (raw && !c) return res.status(400).json({ error: 'Embed colour must look like #3b82f6' });
    patch.embed_color = c || null;
  }
  if (b.embedImage !== undefined) {
    const img = E.imageValue(b.embedImage);
    if (img === null) return res.status(400).json({ error: 'Embed image must be a PNG, JPG, WEBP or GIF under ~300 KB, or an https:// link' });
    patch.embed_image = img || null;
  }
  if (b.clearEmbedImage) patch.embed_image = null;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  const { error } = await supabase.from('users').update(patch).eq('id', u.id);
  if (error) {
    if (/duplicate|unique/i.test(error.message || '')) return res.status(409).json({ error: 'That page name is already taken' });
    if (/embed_(title|desc|color|image)/i.test(error.message || '')) return res.status(500).json({ error: 'Run db/migration_embed.sql in Supabase first.' });
    if (MISSING.test(error.message || '')) return res.status(500).json({ error: 'Run db/migration_redeem_branding.sql in Supabase first.' });
    throw error;
  }
  try { require('../services/branding').clear(); } catch { /* optional */ }
  res.json({ message: `Redeem page of ${u.username} saved` });
}));

// Generate keys that belong to a reseller (they appear in their dashboard and
// can only be redeemed on their page).
router.post('/users/:id/keys', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const { data: u } = await supabase.from('users').select('id, username, reseller').eq('id', req.params.id).maybeSingle();
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (!u.reseller) return res.status(400).json({ error: 'This account is not premium' });
  const count = Number(req.body?.count || 0);
  const boosts = Number(req.body?.boostsPerKey || 0);
  if (!Number.isInteger(count) || count < 1 || count > 200) return res.status(400).json({ error: 'Number of keys must be between 1 and 200' });
  if (!Number.isInteger(boosts) || boosts < 1 || boosts > 1000) return res.status(400).json({ error: 'Boosts per key must be a positive integer' });
  const note = String(req.body?.note || '').trim().slice(0, 120) || 'created by admin';
  const seen = new Set();
  const rows = [];
  while (rows.length < count) {
    const code = generateKeyCode();
    if (seen.has(code)) continue;
    seen.add(code);
    rows.push({ code, boosts_value: boosts, source: 'admin', note, owner_id: u.id });
  }
  const { data, error } = await supabase.from('redeem_keys').insert(rows).select('code');
  if (error) throw error;
  res.status(201).json({ message: `${data.length} key${data.length === 1 ? '' : 's'} added to ${u.username}`, codes: data.map((k) => k.code) });
}));

router.delete('/users/:id/keys', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const scope = String(req.query.scope || '');
  if (!['unused', 'all'].includes(scope)) return res.status(400).json({ error: 'scope must be unused or all' });
  let q = supabase.from('redeem_keys').delete({ count: 'exact' }).eq('owner_id', req.params.id);
  if (scope === 'unused') q = q.is('redeemed_at', null);
  const { error, count } = await q;
  if (error) throw error;
  res.json({ message: `${count || 0} key${count === 1 ? '' : 's'} deleted` });
}));

/* --------------------- main site link embed (the admin's) ---------------- */
router.get('/embed', asyncHandler(async (req, res) => {
  const c = await siteEmbed.get();
  res.json({ custom: c, defaults: E.DEFAULT_SITE, limits: E.LIMITS });
}));

router.patch('/embed', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.siteName !== undefined) patch.siteName = E.text(b.siteName, E.LIMITS.siteName);
  if (b.title !== undefined) patch.title = E.text(b.title, E.LIMITS.title);
  if (b.description !== undefined) patch.description = E.text(b.description, E.LIMITS.description);
  if (b.color !== undefined) {
    const raw = String(b.color || '').trim();
    const c = E.colour(raw);
    if (raw && !c) return res.status(400).json({ error: 'Colour must look like #3b82f6' });
    patch.color = c;
  }
  if (b.image !== undefined) {
    const img = E.imageValue(b.image);
    if (img === null) return res.status(400).json({ error: 'Image must be a PNG, JPG, WEBP or GIF under ~300 KB, or an https:// link' });
    patch.image = img;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  await siteEmbed.save(patch);
  res.json({ message: 'Link embed saved', custom: await siteEmbed.get() });
}));

/* ----------------------------- Discord alerts --------------------------- */
// The webhook URL is a secret: it is stored, never sent back (only its last 6 characters).
router.get('/alerts', asyncHandler(async (req, res) => {
  res.json(await alerts.publicConfig());
}));

router.patch('/alerts', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.webhookUrl !== undefined) patch.webhookUrl = b.webhookUrl;
  if (b.events !== undefined) patch.events = b.events;
  if (b.lowStock !== undefined) patch.lowStock = b.lowStock;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    await alerts.save(patch);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
  res.json({ message: 'Discord alerts saved', ...(await alerts.publicConfig()) });
}));

router.post('/alerts/test', asyncHandler(async (req, res) => {
  const r = await alerts.test();
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ message: 'Test message sent — check your Discord channel' });
}));

/* -------------------------------- deposits ------------------------------ */
router.get('/deposits', asyncHandler(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));
  const { data, error } = await supabase
    .from('deposits')
    .select('id, user_id, currency, usd_amount, received, status, tx_id, forwarded, created_at, completed_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  const names = await usernamesById((data || []).map((d) => d.user_id));
  const rows = (data || []).map((d) => ({
    id: d.id, userId: d.user_id, user: names[d.user_id] || '—', currency: d.currency, usd: num(d.usd_amount), received: num(d.received),
    status: d.status, tx: d.tx_id || '', forwarded: Boolean(d.forwarded), createdAt: d.created_at, completedAt: d.completed_at,
  }));
  const done = rows.filter((d) => d.status === 'completed');
  res.json({
    deposits: rows,
    totals: {
      completedUsd: done.reduce((n, d) => n + d.usd, 0),
      completed: done.length,
      pending: rows.filter((d) => d.status === 'pending').length,
      failed: rows.filter((d) => d.status === 'failed').length,
    },
  });
}));

/* ------------------------------- job detail ----------------------------- */
router.get('/jobs/:id', asyncHandler(async (req, res) => {
  if (!mustUuid(req, res)) return;
  const { data: j, error } = await supabase.from('jobs').select('*, users(username), redeem_keys(code, boosts_value)').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const [items, owners] = await Promise.all([
    supabase.from('job_tokens').select('token, attempts, status, queue_order, started_at, updated_at').eq('job_id', j.id).order('queue_order', { ascending: true }).limit(500),
    usernamesById([j.owner_id]),
  ]);
  const cached = Array.isArray(j.cached_items) ? j.cached_items : [];
  res.json({
    job: {
      id: j.id, mode: j.mode, invite: j.invite, status: j.status, requested: j.boosts_requested, delivered: j.boosts_delivered,
      tokens: j.tokens_used, cost: num(j.cost), retries: j.retry_count || 0, autoRetry: Boolean(j.auto_retry),
      user: j.users?.username || null, userId: j.user_id || null, owner: j.owner_id ? owners[j.owner_id] || 'reseller' : null, ownerId: j.owner_id || null,
      key: j.redeem_keys?.code || null, keyBoosts: j.redeem_keys?.boosts_value || null,
      provider: j.salta7_job_id || '', createdAt: j.created_at, updatedAt: j.updated_at, lastProgressAt: j.last_progress_at,
    },
    items: (items.data || []).map((t) => ({ token: mask(t.token), attempts: t.attempts, status: t.status, startedAt: t.started_at, updatedAt: t.updated_at })),
    cachedItems: cached.length,
  });
}));

/* -------------------------------- insights ------------------------------ */
router.get('/insights', asyncHandler(async (req, res) => {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString();
  const [jobs, users14, deps, totals] = await Promise.all([
    supabase.from('jobs').select('owner_id, invite, status, mode, boosts_delivered, created_at').gte('created_at', since30).limit(20000),
    supabase.from('users').select('created_at').gte('created_at', since14).limit(5000),
    supabase.from('deposits').select('usd_amount, status, created_at, completed_at').limit(50000),
    Promise.all([
      countOf(supabase.from('users').select('*', head)),
      countOf(supabase.from('users').select('*', head).eq('reseller', true)),
      countOf(supabase.from('jobs').select('*', head)),
      countOf(supabase.from('redeem_keys').select('*', head)),
      countOf(supabase.from('stock_tokens').select('*', head).eq('status', 'unused')),
      supabase.from('users').select('balance').limit(50000),
    ]),
  ]);

  const J = (jobs.data || []).filter((j) => j.mode !== 'join');
  const finished = J.filter((j) => j.status === 'completed' || j.status === 'failed');
  const ok = finished.filter((j) => j.status === 'completed').length;

  const byOwner = {};
  const byInvite = {};
  for (const j of J) {
    const b = num(j.boosts_delivered);
    if (j.owner_id) { const o = (byOwner[j.owner_id] ||= { boosts: 0, orders: 0 }); o.boosts += b; o.orders += 1; }
    const code = String(j.invite || '').replace(/^.*(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\//i, '').split(/[/?#\s]/)[0].slice(0, 40);
    if (code) { const s = (byInvite[code] ||= { boosts: 0, orders: 0 }); s.boosts += b; s.orders += 1; }
  }
  const top = (m, n) => Object.entries(m).sort((a, b) => b[1].boosts - a[1].boosts || b[1].orders - a[1].orders).slice(0, n);
  const topOwners = top(byOwner, 6);
  const names = await usernamesById(topOwners.map(([id]) => id));

  const dayKeys = [];
  for (let i = 13; i >= 0; i -= 1) dayKeys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const signups = Object.fromEntries(dayKeys.map((d) => [d, 0]));
  (users14.data || []).forEach((u) => { const d = String(u.created_at).slice(0, 10); if (d in signups) signups[d] += 1; });
  const revenue = Object.fromEntries(dayKeys.map((d) => [d, 0]));
  let revenueTotal = 0;
  (deps.data || []).filter((d) => d.status === 'completed').forEach((d) => {
    revenueTotal += num(d.usd_amount);
    const day = String(d.completed_at || d.created_at).slice(0, 10);
    if (day in revenue) revenue[day] += num(d.usd_amount);
  });

  const [usersTotal, resellersTotal, jobsTotal, keysTotal, stockUnused, bal] = totals;
  res.json({
    totals: {
      users: usersTotal, resellers: resellersTotal, jobs: jobsTotal, keys: keysTotal, stockUnused,
      wallets: (bal.data || []).reduce((n, u) => n + num(u.balance), 0), depositsUsd: revenueTotal,
    },
    success: { rate: finished.length ? Math.round((ok / finished.length) * 100) : null, completed: ok, failed: finished.length - ok, windowDays: 30 },
    topResellers: topOwners.map(([id, v]) => ({ id, username: names[id] || 'reseller', boosts: v.boosts, orders: v.orders })),
    topServers: top(byInvite, 6).map(([invite, v]) => ({ invite, boosts: v.boosts, orders: v.orders })),
    signups: dayKeys.map((date) => ({ date, count: signups[date] })),
    revenue: dayKeys.map((date) => ({ date, usd: Number(revenue[date].toFixed(2)) })),
  });
}));

/* -------------------------------- system -------------------------------- */
router.get('/system', asyncHandler(async (req, res) => {
  const probe = async (table, cols) => {
    const { error } = await supabase.from(table).select(cols).limit(1);
    return !error;
  };
  const env = (k) => Boolean(process.env[k] && String(process.env[k]).trim());
  const [resellers, branding, adminTools, auditTable, sellauthTable, sellauthUsers, checks, embedCols, directCol] = await Promise.all([
    probe('users', 'reseller, redeem_slug, boost_price'),
    probe('users', 'redeem_color, redeem_icon, redeem_brand'),
    probe('users', 'disabled, admin_note'),
    probe('admin_audit', 'id'),
    probe('sellauth_products', 'id'),
    probe('users', 'sellauth_ref, sellauth_secret'),
    probe('token_checks', 'id'),
    probe('users', 'embed_title, embed_desc, embed_color, embed_image'),
    probe('users', 'sellauth_mode'),
  ]);
  const tables = ['users', 'redeem_keys', 'stock_tokens', 'jobs', 'job_tokens', 'deposits', 'sellauth_deliveries', 'token_checks', 'admin_audit'];
  const counts = await Promise.all(tables.map((t) => countOf(supabase.from(t).select('*', head))));

  res.json({
    runtime: {
      node: process.version, platform: `${os.platform()} ${os.arch()}`, uptimeSec: Math.round(process.uptime()),
      env: process.env.NODE_ENV || 'development', serverless: Boolean(process.env.VERCEL),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576), maintenance: String(process.env.MAINTENANCE_MODE || '').toLowerCase() === 'true',
    },
    config: [
      { key: 'JWT_SECRET', ok: env('JWT_SECRET'), note: 'Signs every session' },
      { key: 'ADMIN_PANEL_PASSWORD', ok: env('ADMIN_PANEL_PASSWORD'), note: 'Second password of this panel' },
      { key: 'SUPABASE_URL', ok: env('SUPABASE_URL'), note: 'Database' },
      { key: 'SUPABASE_SERVICE_ROLE_KEY', ok: env('SUPABASE_SERVICE_ROLE_KEY'), note: 'Database access key' },
      { key: 'SALTA7_MASTER_TOKEN', ok: env('SALTA7_MASTER_TOKEN'), note: 'Boost provider — boosts cannot run without it' },
      { key: 'SELLAUTH_WEBHOOK_SECRET', ok: env('SELLAUTH_WEBHOOK_SECRET'), note: 'Optional — SellAuth delivery' },
      { key: 'CRON_SECRET', ok: env('CRON_SECRET'), note: 'Optional — lets a pinger advance direct SellAuth boosts on serverless hosting (Vercel)' },
      { key: 'TATUM_API_KEY', ok: env('TATUM_API_KEY'), note: 'Optional — wallet top-ups' },
    ],
    migrations: [
      { name: 'Resellers', file: 'migration_resellers.sql', ok: resellers },
      { name: 'Redeem page branding', file: 'migration_redeem_branding.sql', ok: branding },
      { name: 'Admin tools (suspend, notes, activity)', file: 'migration_admin_tools.sql', ok: adminTools && auditTable },
      { name: 'Link embed (premium pages)', file: 'migration_embed.sql', ok: embedCols },
      { name: 'SellAuth direct delivery (premium setting)', file: 'migration_sellauth_direct.sql', ok: directCol },
      { name: 'SellAuth', file: 'migration_sellauth.sql', ok: sellauthTable },
      { name: 'SellAuth per premium account', file: 'migration_sellauth_users.sql', ok: sellauthUsers },
      { name: 'Token checker', file: 'migration_resellers.sql', ok: checks },
    ],
    tables: tables.map((t, i) => ({ table: t, rows: counts[i] })),
  });
}));

module.exports = router;
