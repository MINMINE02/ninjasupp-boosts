'use strict';

/**
 * SellAuth "Dynamic Delivery" endpoint.
 *
 * SellAuth POSTs one JSON request per invoice item to the webhook URL set on
 * the product (Deliverables -> Dynamic Delivery). We answer HTTP 200 with the
 * text to hand to the customer: one line = one deliverable. Here that is a
 * single freshly generated redeem key worth N boosts — OR, in DIRECT mode (the
 * default), the server is boosted right away with the invite the buyer typed in
 * the "Server Link" custom field, and no key is handed out at all.
 *
 *   Direct mode : the buyer's invite is used straight away; if it is missing /
 *                 invalid, or the boost cannot start (no stock, no credit,
 *                 provider down), a key is delivered instead so a paying
 *                 customer is never left empty-handed.
 *   Key mode    : the old behaviour (a key worth N boosts).
 *   Choose per product with  ?mode=direct  /  ?mode=key  on the webhook URL, or
 *   set the default in the panel.
 *
 *   Webhook URL : https://YOUR-DOMAIN/api/sellauth/deliver          (platform owner)
 *                 https://YOUR-DOMAIN/api/sellauth/r/<ref>          (a reseller)
 *   Per product : https://YOUR-DOMAIN/api/sellauth/deliver?boosts=14
 *
 * Security  : every request carries X-Signature = HMAC-SHA256(rawBody, secret)
 *             (secret: Storefront -> Configure -> Miscellaneous in SellAuth).
 * Retries   : SellAuth retries on timeouts, so the Idempotency-Key header is
 *             stored — a retry gets the SAME key back instead of a new one.
 */

const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { asyncHandler, generateKeyCode, parseInviteCode } = require('../utils/helpers');
const { getConfig } = require('../services/config');
const { startRedeem } = require('./boost');
const jobDriver = require('../services/jobDriver');
const alerts = require('../services/alerts');
const { originOf } = require('../services/embed');

const PROCESSING = 'processing';              // marker on the delivery row while a direct boost is starting
const PROCESSING_STALE_MS = 90_000;            // a lock older than this is taken over by a retry
const MODES = ['direct', 'key'];

const router = express.Router();

async function getWebhookSecret() {
  return process.env.SELLAUTH_WEBHOOK_SECRET || (await getConfig('sellauth_webhook_secret')) || '';
}

function validSignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(header).trim().toLowerCase();
  if (got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

// First defined, non-empty value among several possible payload paths — the
// exact payload layout can differ between SellAuth versions, so be lenient.
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    for (const part of p.split('.')) {
      cur = cur == null ? undefined : cur[part];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}


// ---- "Server Link" custom field -------------------------------------------
// The buyer types their Discord invite in a SellAuth custom field. Depending on
// the payload version it can arrive as a top-level key, inside `custom_fields`
// (object or [{ name, value }] list), or nested under the item — so walk the
// whole payload and accept several spellings of the field name.
const DEFAULT_LINK_FIELD = 'Server Link';
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const FALLBACK_NAMES = ['serverlink', 'serverinvite', 'invitelink', 'discordinvite', 'discordserver', 'discordserverlink', 'invite'];

function findCustomField(node, names, depth = 0) {
  if (node == null || depth > 5 || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') {
        const label = item.name ?? item.label ?? item.key ?? item.field;
        const value = item.value ?? item.answer;
        if (label != null && names.has(norm(label)) && typeof value === 'string' && value.trim()) return value;
      }
      const deeper = findCustomField(item, names, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  }
  for (const [k, v] of Object.entries(node)) {
    if (names.has(norm(k))) {
      if (typeof v === 'string' && v.trim()) return v;
      if (v && typeof v === 'object' && typeof v.value === 'string' && v.value.trim()) return v.value;
    }
  }
  for (const v of Object.values(node)) {
    const deeper = findCustomField(v, names, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

// Returns a clean "discord.gg/<code>" link, or null if the buyer typed nothing usable.
async function extractServerLink(body, configuredField) {
  const configured = configuredField || DEFAULT_LINK_FIELD;
  const names = new Set([norm(configured), ...FALLBACK_NAMES]);
  const raw = findCustomField(body, names);
  if (!raw) return null;
  const text = String(raw).trim();
  // Accept a Discord invite URL, or a bare code with nothing else around it.
  const isUrl = /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\//i.test(text);
  if (!isUrl && /\s/.test(text)) return null;
  const code = parseInviteCode(text);
  return /^[A-Za-z0-9-]{2,32}$/.test(code) ? `discord.gg/${code}` : null;
}

async function resolveBoosts(req, body, ctx) {
  // 1) explicit ?boosts=N on the webhook URL of that product
  const fromQuery = parseInt(req.query.boosts, 10);
  if (Number.isInteger(fromQuery) && fromQuery > 0) return { boosts: fromQuery, via: 'url' };

  // 2) admin mapping: variant id first, then product id
  const variantId = pick(body, ['variant.id', 'variant_id', 'item.variant.id', 'item.variant_id', 'product.variant.id']);
  const productId = pick(body, ['product.id', 'product_id', 'item.product.id', 'item.product_id']);
  const ids = [variantId, productId].filter((v) => v !== null).map(String);
  if (ids.length) {
    // Links are per owner: the platform's own (owner NULL) or one reseller's.
    const q = supabase.from('sellauth_products').select('sellauth_id, boosts_value').in('sellauth_id', ids);
    const { data } = await (ctx.ownerId ? q.eq('owner_id', ctx.ownerId) : q.is('owner_id', null));
    for (const id of ids) {
      const hit = (data || []).find((r) => r.sellauth_id === id);
      if (hit) return { boosts: hit.boosts_value, via: 'mapping' };
    }
  }

  // 3) "14 Boosts" in the variant / product name
  const names = [
    pick(body, ['variant.name', 'item.variant.name', 'product.variant.name']),
    pick(body, ['product.name', 'item.product.name']),
  ].filter(Boolean);
  for (const name of names) {
    const m = String(name).match(/(\d{1,3})\s*(?:x\s*)?boosts?/i);
    if (m && Number(m[1]) > 0) return { boosts: Number(m[1]), via: 'name' };
  }

  // 4) fallback amount set in the panel
  const def = parseInt(await ctx.defaultBoosts(), 10);
  if (Number.isInteger(def) && def > 0) return { boosts: def, via: 'default' };

  return null;
}

router.get('/health', asyncHandler(async (req, res) => {
  res.json({ ok: true, secretConfigured: Boolean(await getWebhookSecret()) });
}));

// The buyer's confirmation. The link opens a live progress page (/status/<job id>).
const directMessage = (boosts, link, jobId, origin) =>
  `Boost started: ${boosts} boost${Number(boosts) === 1 ? '' : 's'} on ${link} — it is applied within a few minutes.${origin && jobId ? ` Track it live: ${origin}/status/${jobId}` : ''}`;

// Creates a key row. `source` 'sellauth-direct' = an internal key that only exists to
// carry a direct boost (it is never shown to the buyer unless the boost could not start).
async function createKey({ ownerId, boosts, serverLink, source, invoiceId }) {
  for (let i = 0; i < 5; i += 1) {
    const { data, error } = await supabase
      .from('redeem_keys')
      .insert({
        code: generateKeyCode(),
        boosts_value: boosts,
        source,
        server_link: serverLink,
        ...(ownerId ? { owner_id: ownerId } : {}),
        note: invoiceId ? `SellAuth invoice ${invoiceId}` : 'SellAuth',
      })
      .select('id, code')
      .single();
    if (!error) return data;
    if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  throw new Error('Could not generate a unique key');
}

// What to answer a RETRY of a delivery we already completed.
async function replayText(existing, origin) {
  const { data: key } = await supabase.from('redeem_keys').select('id, source, boosts_value, server_link').eq('code', existing.key_code).maybeSingle();
  if (key && key.source === jobDriver.DIRECT_SOURCE) {
    const { data: job } = await supabase.from('jobs').select('id').eq('key_id', key.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    return directMessage(key.boosts_value, existing.server_link || key.server_link || 'your server', job && job.id, origin);
  }
  return existing.key_code;
}

// One implementation for the platform owner (/deliver) and for every reseller
// (/r/:ref). ctx = { ownerId, secret, defaultBoosts(), linkField, mode }.
async function deliver(req, res, ctx) {
  const { ownerId, secret } = ctx;
  if (!secret) {
    return res.status(503).type('text/plain').send('SellAuth webhook secret is not configured');
  }
  if (!validSignature(req.rawBody, req.get('X-Signature'), secret)) {
    return res.status(401).type('text/plain').send('Invalid signature');
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Scoped by owner so one reseller can never replay (and read) another's delivery.
  const idem =
    (ownerId ? `${ownerId}:` : '') +
    (req.get('Idempotency-Key') || crypto.createHash('sha256').update(req.rawBody).digest('hex'));

  const invoiceId = pick(body, ['invoice.id', 'invoice_id', 'invoice.unique_id', 'id']);
  const productId = pick(body, ['product.id', 'product_id', 'item.product.id']);
  const productName = pick(body, ['product.name', 'item.product.name']);
  const payload = JSON.stringify(body).length < 20000 ? body : { truncated: true };

  // Retry of a delivery we already completed -> same answer, nothing new started.
  const { data: existing } = await supabase
    .from('sellauth_deliveries')
    .select('id, status, key_code, error, server_link, boosts_value, created_at')
    .eq('idempotency_key', idem)
    .maybeSingle();
  if (existing && existing.status === 'delivered' && existing.key_code) {
    return res.status(200).type('text/plain').send(await replayText(existing, originOf(req)));
  }
  // The first attempt is still starting the boost: ask SellAuth to come back.
  const age = existing ? Date.now() - new Date(existing.created_at).getTime() : 0;
  if (existing && existing.status === 'error' && existing.error === PROCESSING && age < PROCESSING_STALE_MS) {
    return res.status(503).type('text/plain').send('Delivery in progress, please retry shortly');
  }

  const resolved = await resolveBoosts(req, body, ctx);
  const serverLink = await extractServerLink(body, ctx.linkField);
  const base = {
    idempotency_key: idem,
    invoice_id: invoiceId != null ? String(invoiceId) : null,
    product_id: productId != null ? String(productId) : null,
    product_name: productName != null ? String(productName).slice(0, 200) : null,
    server_link: serverLink,
    payload,
    ...(ownerId ? { owner_id: ownerId } : {}),
  };
  const baseInvoice = base.invoice_id;

  if (!resolved) {
    const row = { ...base, status: 'error', error: 'Could not work out how many boosts this product is worth' };
    if (existing) await supabase.from('sellauth_deliveries').update(row).eq('id', existing.id);
    else await supabase.from('sellauth_deliveries').insert(row);
    return res.status(422).type('text/plain').send('Product is not linked to a boost amount');
  }

  const mode = MODES.includes(String(req.query.mode || '').toLowerCase())
    ? String(req.query.mode).toLowerCase()
    : (MODES.includes(ctx.mode) ? ctx.mode : 'direct');

  // Why a key is handed out instead of boosting directly (shown in the delivery log).
  let fallbackNote = null;

  /* --------------------------- DIRECT: boost now --------------------------- */
  if (mode === 'direct' && serverLink) {
    const invite = parseInviteCode(serverLink);
    // 1) lock the delivery row so a SellAuth retry can't start a second boost
    const lockRow = { ...base, boosts_value: resolved.boosts, status: 'error', error: PROCESSING };
    let lockErr;
    if (existing) {
      ({ error: lockErr } = await supabase.from('sellauth_deliveries').update({ ...lockRow, created_at: new Date().toISOString() }).eq('id', existing.id));
    } else {
      ({ error: lockErr } = await supabase.from('sellauth_deliveries').insert(lockRow));
    }
    if (lockErr) {
      // Lost a race with an identical request that is already on it.
      return res.status(503).type('text/plain').send('Delivery in progress, please retry shortly');
    }

    // 2) the internal key that carries the boost — reuse the one of a crashed attempt
    let key = null;
    if (existing && existing.key_code) {
      const { data: old } = await supabase.from('redeem_keys').select('*').eq('code', existing.key_code).maybeSingle();
      if (old && old.source === jobDriver.DIRECT_SOURCE) {
        if (old.redeemed_at) {
          const { data: oldJob } = await supabase.from('jobs').select('id').eq('key_id', old.id).limit(1).maybeSingle();
          if (oldJob) { // the boost DID start before the crash: finish the bookkeeping, start nothing
            await supabase.from('sellauth_deliveries').update({ status: 'delivered', error: null }).eq('idempotency_key', idem);
            return res.status(200).type('text/plain').send(directMessage(old.boosts_value, serverLink, oldJob.id, originOf(req)));
          }
          await supabase.from('redeem_keys').update({ redeemed_at: null, redeemed_invite: null }).eq('id', old.id);
        }
        key = { ...old, redeemed_at: null };
      }
    }
    if (!key) {
      key = await createKey({ ownerId, boosts: resolved.boosts, serverLink, source: jobDriver.DIRECT_SOURCE, invoiceId: baseInvoice });
      key = { ...key, boosts_value: resolved.boosts, boosts_delivered: 0, owner_id: ownerId || null, redeemed_at: null };
    }
    await supabase.from('sellauth_deliveries').update({ key_code: key.code }).eq('idempotency_key', idem);

    // 3) start the boost (stock, credit and the provider are all checked in here)
    let r;
    try {
      r = await startRedeem(key, invite, null, { direct: true });
    } catch (err) {
      r = { status: 500, body: { error: err.message || 'unexpected error' } };
    }
    if (r.status === 201 && r.body && r.body.job) {
      await supabase.from('sellauth_deliveries').update({ status: 'delivered', error: null, boosts_value: resolved.boosts, key_code: key.code }).eq('idempotency_key', idem);
      // Nobody is watching this job: make sure it keeps moving even right away.
      jobDriver.syncDirectJobs().catch(() => {});
      const trackUrl = `${originOf(req)}/status/${r.body.job.id}`;
      await alerts.orderDelivered({ direct: true, boosts: resolved.boosts, server: serverLink, ownerId, invoice: baseInvoice, product: productName, trackUrl });
      return res.status(200).type('text/plain').send(directMessage(resolved.boosts, serverLink, r.body.job.id, originOf(req)));
    }

    // 4) could not start -> the key was released: hand it out so the buyer still gets what they paid for
    fallbackNote = `Direct boost could not start (${(r.body && r.body.error) || 'unknown error'}) — a key was delivered instead`;
    await supabase.from('redeem_keys').update({ source: 'sellauth', note: `${baseInvoice ? `SellAuth invoice ${baseInvoice}` : 'SellAuth'} (direct boost failed)` }).eq('id', key.id);
    await supabase.from('sellauth_deliveries').update({ status: 'delivered', error: fallbackNote, boosts_value: resolved.boosts, key_code: key.code }).eq('idempotency_key', idem);
    await alerts.orderDelivered({ direct: false, boosts: resolved.boosts, server: serverLink, ownerId, invoice: baseInvoice, product: productName, note: fallbackNote });
    return res.status(200).type('text/plain').send(key.code);
  }

  if (mode === 'direct' && !serverLink) {
    fallbackNote = 'No valid server link in the order (custom field empty or not an invite) — a key was delivered instead';
  }

  /* ------------------------------ KEY: hand out ---------------------------- */
  const key = await createKey({ ownerId, boosts: resolved.boosts, serverLink, source: 'sellauth', invoiceId: baseInvoice });

  const row = { ...base, boosts_value: resolved.boosts, key_code: key.code, status: 'delivered', error: fallbackNote };
  let saveErr;
  if (existing) {
    ({ error: saveErr } = await supabase.from('sellauth_deliveries').update(row).eq('id', existing.id));
  } else {
    ({ error: saveErr } = await supabase.from('sellauth_deliveries').insert(row));
  }

  if (saveErr) {
    // Two identical requests raced: keep the first key, drop ours.
    await supabase.from('redeem_keys').delete().eq('id', key.id);
    const { data: winner } = await supabase
      .from('sellauth_deliveries')
      .select('key_code')
      .eq('idempotency_key', idem)
      .maybeSingle();
    if (winner?.key_code) return res.status(200).type('text/plain').send(winner.key_code);
    throw saveErr;
  }

  await alerts.orderDelivered({ direct: false, boosts: resolved.boosts, server: serverLink, ownerId, invoice: baseInvoice, product: productName, note: fallbackNote });
  res.status(200).type('text/plain').send(key.code);
}

router.post(
  '/deliver',
  asyncHandler(async (req, res) => deliver(req, res, {
    ownerId: null,
    secret: await getWebhookSecret(),
    defaultBoosts: () => getConfig('sellauth_default_boosts'),
    linkField: await getConfig('sellauth_link_field'),
    mode: await getConfig('sellauth_delivery_mode'),
  }))
);

// Reseller webhook: https://YOUR-DOMAIN/api/sellauth/r/<ref>
// Keys are created for that reseller, signed with THEIR secret, and only
// redeemable with THEIR stock.
router.post(
  '/r/:ref',
  asyncHandler(async (req, res) => {
    const ref = String(req.params.ref || '');
    const load = async (cols) => (ref.length >= 16
      ? supabase.from('users').select(cols).eq('sellauth_ref', ref).maybeSingle()
      : { data: null });
    let { data: u, error: uErr } = await load('id, reseller, sellauth_secret, sellauth_default_boosts, sellauth_mode');
    // db/migration_sellauth_direct.sql not run yet: still serve the webhook (direct is the default)
    if (uErr) ({ data: u } = await load('id, reseller, sellauth_secret, sellauth_default_boosts'));
    if (!u) return res.status(404).type('text/plain').send('Unknown webhook');
    if (!u.reseller) return res.status(403).type('text/plain').send('Premium access is disabled');
    return deliver(req, res, {
      ownerId: u.id,
      secret: u.sellauth_secret || '',
      defaultBoosts: () => u.sellauth_default_boosts,
      linkField: null,
      mode: u.sellauth_mode || null,
    });
  })
);

module.exports = router;
