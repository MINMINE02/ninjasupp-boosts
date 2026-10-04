'use strict';

/* =========================================================================
 * Discord alerts — the panel posts to a Discord channel (webhook) when:
 *   orders     a SellAuth order came in (boosted directly, or a key delivered)
 *   completed  a boost finished
 *   failed     a boost failed
 *   lowstock   a stock pool (platform or a reseller) is running low
 *
 * Configured by the admin (Settings -> Discord alerts), stored in app_config.
 * Everything here is best-effort: an alert problem must never break an order,
 * so nothing in this file ever throws, and every send has a short timeout
 * (serverless hosts freeze right after the response, so alerts are awaited).
 * ========================================================================= */

const supabase = require('../config/supabase');
const { getConfig, setConfig } = require('./config');

const EVENTS = ['orders', 'completed', 'failed', 'lowstock'];
const DEFAULT_LOW_STOCK = 20;
const COOLDOWN_MS = 6 * 3600 * 1000; // one low-stock alert per pool every 6 h
const SEND_TIMEOUT_MS = 2500;
const CACHE_MS = 15_000;

// Only real Discord webhook URLs — never an arbitrary address (no SSRF).
const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9._-]{20,120}$/;
const COLORS = { order: 0xff2d3f, ok: 0x22c55e, bad: 0xef4444, warn: 0xf59e0b, info: 0x3b82f6 };

let cache = null;
let lastOrigin = '';

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
const parseEvents = (csv) => {
  if (csv == null || csv === '') return new Set(EVENTS);            // never configured -> everything on
  return new Set(String(csv).split(',').map((s) => s.trim()).filter((s) => EVENTS.includes(s)));
};

/* ------------------------------ configuration ----------------------------- */
async function load() {
  const [url, events, low] = await Promise.all([
    getConfig('alert_webhook'), getConfig('alert_events'), getConfig('alert_low_stock'),
  ]);
  const n = low == null || String(low).trim() === '' ? NaN : Number(low); // never set -> default (Number(null) would be 0)
  return {
    url: WEBHOOK_RE.test(String(url || '')) ? String(url) : '',
    events: parseEvents(events),
    lowStock: Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LOW_STOCK,
  };
}
async function config() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  try { value = await load(); } catch { value = { url: '', events: new Set(), lowStock: DEFAULT_LOW_STOCK }; }
  cache = { at: Date.now(), value };
  return value;
}

// What the admin panel may see: never the full URL (it is a secret).
async function publicConfig() {
  const c = await config();
  return {
    configured: Boolean(c.url),
    tail: c.url ? c.url.slice(-6) : '',
    events: Object.fromEntries(EVENTS.map((e) => [e, c.events.has(e)])),
    lowStock: c.lowStock,
  };
}

// patch: { webhookUrl?: string ('' removes), events?: {orders,completed,failed,lowstock}, lowStock?: number }
async function save(patch) {
  if (patch.webhookUrl !== undefined) {
    const u = String(patch.webhookUrl || '').trim();
    if (u && !WEBHOOK_RE.test(u)) {
      const e = new Error('That is not a Discord webhook URL (it looks like https://discord.com/api/webhooks/123…/abc…)');
      e.status = 400;
      throw e;
    }
    await setConfig('alert_webhook', u);
  }
  if (patch.events !== undefined && patch.events && typeof patch.events === 'object') {
    await setConfig('alert_events', EVENTS.filter((e) => patch.events[e]).join(',') || 'none');
  }
  if (patch.lowStock !== undefined) {
    const n = Number(patch.lowStock);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      const e = new Error('Low-stock threshold must be a whole number between 0 and 100000');
      e.status = 400;
      throw e;
    }
    await setConfig('alert_low_stock', String(n));
  }
  cache = null;
}

/* -------------------------------- sending --------------------------------- */
async function post(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Ninja Boost', allowed_mentions: { parse: [] }, ...body }),
      signal: ctrl.signal,
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(t);
  }
}

const field = (name, value, inline = true) => ({ name: clip(name, 256), value: clip(value || '—', 1024) || '—', inline });
const embed = (title, color, fields, description) => ({
  title: clip(title, 256),
  ...(description ? { description: clip(description, 2000) } : {}),
  color,
  fields,
  footer: { text: 'Ninja Boost' },
  timestamp: new Date().toISOString(),
});

async function sellerName(ownerId) {
  if (!ownerId) return 'Platform';
  try {
    const { data } = await supabase.from('users').select('username').eq('id', ownerId).maybeSingle();
    return data && data.username ? data.username : 'Reseller';
  } catch { return 'Reseller'; }
}
const origin = () => (process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/+$/, '') : lastOrigin);
const seenOrigin = (req) => {
  try {
    const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:-]/g, '');
    if (host) lastOrigin = `${req.protocol}://${host}`;
  } catch { /* ignore */ }
};

// event: one of EVENTS. embeds: array of Discord embeds. Never throws.
async function send(event, embeds) {
  try {
    const c = await config();
    if (!c.url || !c.events.has(event)) return false;
    const r = await post(c.url, { embeds });
    return r.ok;
  } catch { return false; }
}

/* --------------------------------- events --------------------------------- */
// A SellAuth order was handled. d = { direct, boosts, server, ownerId, invoice, product, jobId, note, trackUrl }
async function orderDelivered(d) {
  try {
    const c = await config();
    if (!c.url || !c.events.has('orders')) return false;
    const seller = await sellerName(d.ownerId);
    const fields = [
      field('Server', d.server || 'no link', true),
      field('Boosts', d.boosts, true),
      field('Seller', seller, true),
      field('Product', d.product, true),
      field('Invoice', d.invoice, true),
    ];
    if (d.note) fields.push(field('Note', d.note, false));
    if (d.trackUrl) fields.push(field('Live status', d.trackUrl, false));
    return await send('orders', [embed(
      d.direct ? '🚀 New order — boosting directly' : '🔑 New order — key delivered',
      d.direct ? COLORS.order : COLORS.info,
      fields,
    )]);
  } catch { return false; }
}

// A boost finished. job = jobs row, state = 'completed' | 'failed'
async function jobFinished(job, state, delivered, extra = {}) {
  try {
    const c = await config();
    const event = state === 'completed' ? 'completed' : 'failed';
    if (!c.url || !c.events.has(event)) return false;
    const seller = await sellerName(job.owner_id);
    const ok = state === 'completed';
    const base = origin();
    const fields = [
      field('Server', job.invite ? `discord.gg/${job.invite}` : '—', true),
      field('Boosts', `${delivered}/${job.boosts_requested}`, true),
      field('Seller', seller, true),
      field('Type', job.mode === 'byot' ? 'own tokens' : 'key', true),
    ];
    if (extra.keyCode) fields.push(field('Key', extra.keyCode, true));
    if (extra.direct) fields.push(field('Delivery', 'SellAuth (direct)', true));
    if (base) fields.push(field('Job', `${base}/admin#/job/${job.id}`, false));
    return await send(event, [embed(
      ok ? '✅ Boost completed' : '❌ Boost failed',
      ok ? COLORS.ok : COLORS.bad,
      fields,
      ok ? null : (extra.direct
        ? 'This buyer was delivered directly (no key). Check the job, then send a new key or refund.'
        : 'Not every boost could be delivered.'),
    )]);
  } catch { return false; }
}

// Called after stock was taken from a pool (ownerId null = platform pool).
async function checkStock(ownerId) {
  try {
    const c = await config();
    if (!c.url || !c.events.has('lowstock') || c.lowStock <= 0) return false;
    let q = supabase.from('stock_tokens').select('*', { count: 'exact', head: true }).eq('status', 'unused');
    q = ownerId ? q.eq('owner_id', ownerId) : q.is('owner_id', null);
    const { count, error } = await q;
    if (error || count == null) return false;

    const flagKey = `alert_lowstock_${ownerId || 'platform'}`;
    const last = await getConfig(flagKey);
    if (count >= c.lowStock) {                      // healthy again -> re-arm
      if (last) await setConfig(flagKey, '');
      return false;
    }
    if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) return false;
    await setConfig(flagKey, new Date().toISOString());
    const seller = await sellerName(ownerId);
    return await send('lowstock', [embed(
      count === 0 ? '🛑 Stock is empty' : '⚠️ Stock is running low',
      count === 0 ? COLORS.bad : COLORS.warn,
      [field('Pool', ownerId ? `${seller} (premium)` : 'Platform', true), field('Tokens left', count, true), field('Alert below', c.lowStock, true)],
      count === 0
        ? 'Direct SellAuth orders will now fall back to keys until stock is added.'
        : 'Add tokens soon so orders keep being boosted directly.',
    )]);
  } catch { return false; }
}

// Settings page "Send a test message". Reports what Discord answered.
async function test() {
  const c = await config();
  if (!c.url) return { ok: false, error: 'No webhook saved yet' };
  const r = await post(c.url, {
    embeds: [embed('🔔 Test alert', COLORS.ok, [field('Status', 'Your Discord alerts work.', false)], 'You will get new orders, finished or failed boosts and low-stock warnings here.')],
  });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.status === 404 ? 'Discord says this webhook no longer exists (deleted?)' : r.status === 0 ? `Could not reach Discord (${r.error})` : `Discord answered ${r.status}` };
}

const clearCache = () => { cache = null; };

module.exports = { EVENTS, WEBHOOK_RE, publicConfig, save, orderDelivered, jobFinished, checkStock, test, seenOrigin, clearCache };
