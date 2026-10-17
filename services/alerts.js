'use strict';

/* =========================================================================
 * Discord alerts — the panel posts to a Discord channel (webhook) when:
 *   orders     a SellAuth order came in (boosted directly, or a key delivered)
 *   completed  a boost finished
 *   failed     a boost failed
 *   lowstock   a stock pool (platform or a reseller) is running low
 *   shop       (admin only) a shop order is stuck: paid short, or stuck while processing
 *
 * The admin sets a webhook for EVERYTHING (Settings -> Discord alerts, stored in app_config).
 * Each premium (reseller) account can also set its OWN webhook and receives only the
 * events about its own orders, boosts and stock (stored on the user row). A premium
 * webhook never receives anything about another account or about the admin panel.
 *
 * Everything here is best-effort: an alert problem must never break an order,
 * so nothing in this file ever throws, and every send has a short timeout
 * (serverless hosts freeze right after the response, so alerts are awaited).
 * ========================================================================= */

const supabase = require('../config/supabase');
const { getConfig, setConfig } = require('./config');

const EVENTS = ['orders', 'completed', 'failed', 'lowstock', 'lowbalance', 'shop'];
const ADMIN_ONLY_EVENTS = ['lowbalance', 'shop']; // never offered to / stored for a premium account
const DEFAULT_LOW_STOCK = 20;
const DEFAULT_LOW_BALANCE = 5; // USD on the Salta7 account
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
  const [url, events, low, lowBal] = await Promise.all([
    getConfig('alert_webhook'), getConfig('alert_events'), getConfig('alert_low_stock'), getConfig('alert_low_balance'),
  ]);
  const n = low == null || String(low).trim() === '' ? NaN : Number(low); // never set -> default (Number(null) would be 0)
  const b = lowBal == null || String(lowBal).trim() === '' ? NaN : Number(lowBal);
  return {
    url: WEBHOOK_RE.test(String(url || '')) ? String(url) : '',
    events: parseEvents(events),
    lowStock: Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LOW_STOCK,
    lowBalance: Number.isFinite(b) && b >= 0 ? b : DEFAULT_LOW_BALANCE,
  };
}
async function config() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  try { value = await load(); } catch { value = { url: '', events: new Set(), lowStock: DEFAULT_LOW_STOCK, lowBalance: DEFAULT_LOW_BALANCE }; }
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
    lowBalance: c.lowBalance,
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
  if (patch.lowBalance !== undefined) {
    const n = Number(patch.lowBalance);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      const e = new Error('Low-balance threshold must be a number between 0 and 100000');
      e.status = 400;
      throw e;
    }
    await setConfig('alert_low_balance', String(n));
  }
  cache = null;
}

/* --------------------- a premium account's own webhook -------------------- */
const rCache = new Map(); // ownerId -> { at, value }
const EMPTY = () => ({ supported: false, url: '', events: new Set(), lowStock: DEFAULT_LOW_STOCK });

async function resellerConfig(ownerId) {
  if (!ownerId) return EMPTY();
  const hit = rCache.get(ownerId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = EMPTY();
  try {
    const { data, error } = await supabase
      .from('users').select('alert_webhook, alert_events, alert_low_stock').eq('id', ownerId).maybeSingle();
    if (!error) { // error = db/migration_premium_tools.sql not run yet -> no personal alerts
      const row = data || {};
      const n = row.alert_low_stock == null ? NaN : Number(row.alert_low_stock);
      value = {
        supported: true,
        url: WEBHOOK_RE.test(String(row.alert_webhook || '')) ? String(row.alert_webhook) : '',
        events: parseEvents(row.alert_events),
        lowStock: Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LOW_STOCK,
      };
    }
  } catch { /* none */ }
  if (rCache.size > 500) rCache.clear();
  rCache.set(ownerId, { at: Date.now(), value });
  return value;
}

// What the account's own dashboard may see: never the full URL.
async function resellerPublicConfig(ownerId) {
  rCache.delete(ownerId);
  const c = await resellerConfig(ownerId);
  return {
    supported: c.supported,
    configured: Boolean(c.url),
    tail: c.url ? c.url.slice(-6) : '',
    events: Object.fromEntries(EVENTS.filter((e) => !ADMIN_ONLY_EVENTS.includes(e)).map((e) => [e, c.events.has(e)])),
    lowStock: c.lowStock,
  };
}

const MIGRATION_HINT = 'This option is temporarily unavailable. Please contact the administrator.';
async function resellerSave(ownerId, patch) {
  const upd = {};
  if (patch.webhookUrl !== undefined) {
    const u = String(patch.webhookUrl || '').trim();
    if (u && !WEBHOOK_RE.test(u)) {
      const e = new Error('That is not a Discord webhook URL (it looks like https://discord.com/api/webhooks/123…/abc…)');
      e.status = 400; throw e;
    }
    upd.alert_webhook = u || null;
  }
  if (patch.events !== undefined && patch.events && typeof patch.events === 'object') {
    upd.alert_events = EVENTS.filter((e) => !ADMIN_ONLY_EVENTS.includes(e) && patch.events[e]).join(',') || 'none';
  }
  if (patch.lowStock !== undefined) {
    const n = Number(patch.lowStock);
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      const e = new Error('Low-stock threshold must be a whole number between 0 and 100000');
      e.status = 400; throw e;
    }
    upd.alert_low_stock = n;
  }
  if (!Object.keys(upd).length) { const e = new Error('Nothing to update'); e.status = 400; throw e; }
  const { error } = await supabase.from('users').update(upd).eq('id', ownerId);
  if (error) {
    if (/alert_|schema cache|column/i.test(error.message || '')) { const e = new Error(MIGRATION_HINT); e.status = 500; throw e; }
    throw error;
  }
  rCache.delete(ownerId);
}

const lastTest = new Map();
async function resellerTest(ownerId) {
  rCache.delete(ownerId);
  const c = await resellerConfig(ownerId);
  if (!c.url) return { ok: false, error: 'No webhook saved yet' };
  const now = Date.now();
  if (now - (lastTest.get(ownerId) || 0) < 10_000) return { ok: false, error: 'Please wait a few seconds between tests' };
  lastTest.set(ownerId, now);
  const r = await post(c.url, {
    embeds: [embed('🔔 Test alert', COLORS.ok, [field('Status', 'Your Discord alerts work.', false)], 'You will get your orders, finished or failed boosts and low-stock warnings here.')],
  });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.status === 404 ? 'Discord says this webhook no longer exists (deleted?)' : r.status === 0 ? `Could not reach Discord (${r.error})` : `Discord answered ${r.status}` };
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
// Where "open in the admin panel" links point. PUBLIC_URL wins. Otherwise the address the ADMIN
// is using is remembered — only ever taken from an authenticated admin request (a forged Host
// header from a stranger can never change where an alert link goes), and kept in the database
// so every serverless instance knows it.
const origin = async () => {
  if (process.env.PUBLIC_URL) return String(process.env.PUBLIC_URL).replace(/\/+$/, '');
  if (lastOrigin) return lastOrigin;
  try { lastOrigin = String((await getConfig('site_origin')) || ''); } catch { /* none */ }
  return lastOrigin;
};
const rememberOrigin = async (req) => {
  try {
    const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:-]/g, '');
    if (!host) return;
    const o = `${req.protocol}://${host}`;
    if (o !== lastOrigin) { lastOrigin = o; await setConfig('site_origin', o); }
  } catch { /* never block a request for this */ }
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
// -> the admin's webhook (everything) and, for a premium account's order, that account's own webhook.
async function orderDelivered(d) {
  try {
    const [c, rc] = await Promise.all([config(), resellerConfig(d.ownerId)]);
    const toAdmin = Boolean(c.url && c.events.has('orders'));
    const toSeller = Boolean(d.ownerId && rc.url && rc.events.has('orders'));
    if (!toAdmin && !toSeller) return false;
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
    const title = d.direct ? '🚀 New order — boosting directly' : '🔑 New order — key delivered';
    const color = d.direct ? COLORS.order : COLORS.info;
    const sends = [];
    if (toAdmin) sends.push(post(c.url, { embeds: [embed(title, color, fields)] }));
    if (toSeller) sends.push(post(rc.url, { embeds: [embed(title, color, fields.filter((f) => f.name !== 'Seller'))] }));
    const out = await Promise.all(sends);
    return out.every((r) => r.ok);
  } catch { return false; }
}

// A boost finished. job = jobs row, state = 'completed' | 'failed'
// -> the admin's webhook and the job owner's own webhook (which never gets admin links).
async function jobFinished(job, state, delivered, extra = {}) {
  try {
    const [c, rc] = await Promise.all([config(), resellerConfig(job.owner_id)]);
    const event = state === 'completed' ? 'completed' : 'failed';
    const toAdmin = Boolean(c.url && c.events.has(event));
    const toSeller = Boolean(job.owner_id && rc.url && rc.events.has(event));
    if (!toAdmin && !toSeller) return false;
    const ok = state === 'completed';
    const fields = [
      field('Server', job.invite ? `discord.gg/${job.invite}` : '—', true),
      field('Boosts', `${delivered}/${job.boosts_requested}`, true),
      field('Type', job.mode === 'byot' ? 'own tokens' : 'key', true),
    ];
    if (extra.keyCode) fields.push(field('Key', extra.keyCode, true));
    if (extra.direct) fields.push(field('Delivery', 'SellAuth (direct)', true));
    const title = ok ? '✅ Boost completed' : '❌ Boost failed';
    const color = ok ? COLORS.ok : COLORS.bad;
    const desc = ok ? null : (extra.direct
      ? 'This buyer was delivered directly (no key). Check the job, then send a new key or refund.'
      : 'Not every boost could be delivered.');
    const sends = [];
    if (toAdmin) {
      const seller = await sellerName(job.owner_id);
      const base = await origin();
      const af = [...fields.slice(0, 2), field('Seller', seller, true), ...fields.slice(2)];
      if (base) af.push(field('Job', `${base}/admin#/job/${job.id}`, false));
      sends.push(post(c.url, { embeds: [embed(title, color, af, desc)] }));
    }
    if (toSeller) sends.push(post(rc.url, { embeds: [embed(title, color, fields, desc)] }));
    const out = await Promise.all(sends);
    return out.every((r) => r.ok);
  } catch { return false; }
}

// Called after stock was taken from a pool (ownerId null = platform pool).
// The admin has his own threshold; the pool's owner (premium account) has theirs.
async function checkStock(ownerId) {
  try {
    const [c, rc] = await Promise.all([config(), resellerConfig(ownerId)]);
    const forAdmin = Boolean(c.url && c.events.has('lowstock') && c.lowStock > 0);
    const forSeller = Boolean(ownerId && rc.url && rc.events.has('lowstock') && rc.lowStock > 0);
    if (!forAdmin && !forSeller) return false;
    let q = supabase.from('stock_tokens').select('*', { count: 'exact', head: true }).eq('status', 'unused');
    q = ownerId ? q.eq('owner_id', ownerId) : q.is('owner_id', null);
    const { count, error } = await q;
    if (error || count == null) return false;

    // one alert per pool and per webhook every 6 h; re-armed once the stock is healthy again
    const pool = async ({ flagKey, threshold, url, pool: label, eventTitle }) => {
      const last = await getConfig(flagKey);
      if (count >= threshold) { if (last) await setConfig(flagKey, ''); return false; }
      if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) return false;
      await setConfig(flagKey, new Date().toISOString());
      const r = await post(url, { embeds: [embed(
        count === 0 ? '🛑 Stock is empty' : eventTitle,
        count === 0 ? COLORS.bad : COLORS.warn,
        [field('Pool', label, true), field('Tokens left', count, true), field('Alert below', threshold, true)],
        count === 0
          ? 'Direct SellAuth orders will now fall back to keys until stock is added.'
          : 'Add tokens soon so orders keep being boosted directly.',
      )] });
      return r.ok;
    };
    const jobs = [];
    if (forAdmin) {
      const seller = await sellerName(ownerId);
      jobs.push(pool({ flagKey: `alert_lowstock_${ownerId || 'platform'}`, threshold: c.lowStock, url: c.url, pool: ownerId ? `${seller} (premium)` : 'Platform', eventTitle: '⚠️ Stock is running low' }));
    }
    if (forSeller) {
      jobs.push(pool({ flagKey: `alert_lowstock_r_${ownerId}`, threshold: rc.lowStock, url: rc.url, pool: 'Your stock', eventTitle: '⚠️ Your stock is running low' }));
    }
    return (await Promise.all(jobs)).some(Boolean);
  } catch { return false; }
}

// The Salta7 balance (USD) was read. Admin only: one alert per 6 h while it is below the
// threshold, re-armed once it is healthy again. Never throws.
async function checkBalance(balance) {
  try {
    const c = await config();
    if (!c.url || !c.events.has('lowbalance') || !(c.lowBalance > 0) || !Number.isFinite(balance)) return false;
    const flagKey = 'alert_lowbalance_platform';
    const last = await getConfig(flagKey);
    if (balance >= c.lowBalance) { if (last) await setConfig(flagKey, ''); return false; }
    if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) return false;
    await setConfig(flagKey, new Date().toISOString());
    const empty = balance <= 0;
    const r = await post(c.url, { embeds: [embed(
      empty ? '🛑 Salta7 balance is empty' : '⚠️ Salta7 balance is low',
      empty ? COLORS.bad : COLORS.warn,
      [field('Balance', `$${balance.toFixed(2)}`, true), field('Alert below', `$${c.lowBalance}`, true)],
      'Boosts, token checks and profile changes will fail once it runs out. Top up your Salta7 account.',
    )] });
    return r.ok;
  } catch { return false; }
}

// Shop orders that need a human: a Litecoin payment that arrived short and was never completed, or an
// order left "processing". Admin only; each order is reported once. Never throws.
const SHOP_STUCK_MS = 15 * 60 * 1000;
async function checkShop() {
  try {
    const c = await config();
    if (!c.url || !c.events.has('shop')) return 0;
    const { data: rows } = await supabase.from('shop_orders')
      .select('id, user_id, pack_name, price_usd, status, deposit_id, created_at')
      .in('status', ['awaiting_payment', 'processing'])
      .lt('created_at', new Date(Date.now() - SHOP_STUCK_MS).toISOString())
      .order('created_at', { ascending: false }).limit(50);
    if (!rows || !rows.length) return 0;

    const depIds = [...new Set(rows.map((o) => o.deposit_id).filter(Boolean))];
    const dep = {};
    if (depIds.length) {
      const { data: ds } = await supabase.from('deposits').select('id, received').in('id', depIds);
      (ds || []).forEach((d) => { dep[d.id] = Number(d.received) || 0; });
    }
    // "awaiting" with nothing received is just an unpaid cart: only report paid-short orders.
    const stuck = rows.filter((o) => o.status === 'processing' || (o.deposit_id && dep[o.deposit_id] > 0));
    let seen = [];
    try { seen = JSON.parse((await getConfig('alert_shop_seen')) || '[]'); } catch { seen = []; }
    if (!Array.isArray(seen)) seen = [];
    const fresh = stuck.filter((o) => !seen.includes(o.id));
    if (!fresh.length) return 0;

    const ids = [...new Set(fresh.map((o) => o.user_id))];
    const { data: us } = await supabase.from('users').select('id, username').in('id', ids);
    const names = Object.fromEntries((us || []).map((u) => [u.id, u.username]));
    const lines = fresh.slice(0, 10).map((o) => `**${clip(names[o.user_id] || 'unknown', 40)}** · ${clip(o.pack_name, 60)} · $${Number(o.price_usd).toFixed(2)} · ${o.status === 'processing' ? 'stuck while processing' : 'paid short'}`);
    const r = await post(c.url, { embeds: [embed(
      `🛒 ${fresh.length} shop order${fresh.length > 1 ? 's' : ''} need${fresh.length > 1 ? '' : 's'} a look`,
      COLORS.warn, [], lines.join('\n'),
    )] });
    if (!r.ok) return 0;                                   // not delivered: try again next time
    await setConfig('alert_shop_seen', JSON.stringify([...fresh.map((o) => o.id), ...seen].slice(0, 300)));
    return fresh.length;
  } catch { return 0; }
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

module.exports = {
  EVENTS, WEBHOOK_RE, publicConfig, save, orderDelivered, jobFinished, checkStock, checkBalance, checkShop, test, rememberOrigin, clearCache,
  resellerPublicConfig, resellerSave, resellerTest,
};
