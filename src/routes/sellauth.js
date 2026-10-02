'use strict';

/**
 * SellAuth "Dynamic Delivery" endpoint.
 *
 * SellAuth POSTs one JSON request per invoice item to the webhook URL set on
 * the product (Deliverables -> Dynamic Delivery). We answer HTTP 200 with the
 * text to hand to the customer: one line = one deliverable. Here that is a
 * single freshly generated redeem key worth N boosts.
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

// One implementation for the platform owner (/deliver) and for every reseller
// (/r/:ref). ctx = { ownerId, secret, defaultBoosts(), linkField }.
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

  // Retry of a delivery we already completed -> same key, no new one.
  const { data: existing } = await supabase
    .from('sellauth_deliveries')
    .select('id, status, key_code')
    .eq('idempotency_key', idem)
    .maybeSingle();
  if (existing && existing.status === 'delivered' && existing.key_code) {
    return res.status(200).type('text/plain').send(existing.key_code);
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

  if (!resolved) {
    const row = { ...base, status: 'error', error: 'Could not work out how many boosts this product is worth' };
    if (existing) await supabase.from('sellauth_deliveries').update(row).eq('id', existing.id);
    else await supabase.from('sellauth_deliveries').insert(row);
    return res.status(422).type('text/plain').send('Product is not linked to a boost amount');
  }

  // Create the key (unique 16-char code, retry on the rare collision).
  let key = null;
  for (let i = 0; i < 5 && !key; i += 1) {
    const { data, error } = await supabase
      .from('redeem_keys')
      .insert({
        code: generateKeyCode(),
        boosts_value: resolved.boosts,
        source: 'sellauth',
        server_link: serverLink,
        ...(ownerId ? { owner_id: ownerId } : {}),
        note: base.invoice_id ? `SellAuth invoice ${base.invoice_id}` : 'SellAuth',
      })
      .select('id, code')
      .single();
    if (!error) key = data;
    else if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  if (!key) throw new Error('Could not generate a unique key');

  const row = { ...base, boosts_value: resolved.boosts, key_code: key.code, status: 'delivered', error: null };
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

  res.status(200).type('text/plain').send(key.code);
}

router.post(
  '/deliver',
  asyncHandler(async (req, res) => deliver(req, res, {
    ownerId: null,
    secret: await getWebhookSecret(),
    defaultBoosts: () => getConfig('sellauth_default_boosts'),
    linkField: await getConfig('sellauth_link_field'),
  }))
);

// Reseller webhook: https://YOUR-DOMAIN/api/sellauth/r/<ref>
// Keys are created for that reseller, signed with THEIR secret, and only
// redeemable with THEIR stock.
router.post(
  '/r/:ref',
  asyncHandler(async (req, res) => {
    const ref = String(req.params.ref || '');
    const { data: u } = ref.length >= 16
      ? await supabase
        .from('users')
        .select('id, reseller, sellauth_secret, sellauth_default_boosts')
        .eq('sellauth_ref', ref)
        .maybeSingle()
      : { data: null };
    if (!u) return res.status(404).type('text/plain').send('Unknown webhook');
    if (!u.reseller) return res.status(403).type('text/plain').send('Reseller access is disabled');
    return deliver(req, res, {
      ownerId: u.id,
      secret: u.sellauth_secret || '',
      defaultBoosts: () => u.sellauth_default_boosts,
      linkField: null,
    });
  })
);

module.exports = router;
