'use strict';

/* =========================================================================
 * Shop — premium + credit packs.
 *
 *   credits  = the account's wallet balance (USD)
 *   premium  = users.reseller, optionally ending on users.premium_until
 *              (NULL = no end: lifetime, or granted by the admin)
 *
 * Every purchase is "wallet based": the price is taken from the wallet and the
 * pack's credits are added to it, then premium is granted. Paying with
 * Litecoin simply tops the wallet up with a deposit made for that order, and
 * the order is fulfilled the moment the deposit is confirmed — so both
 * methods end in exactly the same place. (Run db/migration_shop.sql once.)
 * ========================================================================= */

const supabase = require('../config/supabase');

const DAY_MS = 86_400_000;
const ORDER_TTL_MS = 24 * 3_600_000;         // an unpaid Litecoin order is closed after a day
const MAX_OPEN_ORDERS = 5;                   // unpaid Litecoin orders per account at a time
const KIND_ACCENT = { premium: '#38bdf8', credits: '#22d3ee', bundle: '#ff2d3f' };
const MONEY = (n) => Number(Number(n).toFixed(4));
const cents = (n) => Math.round(Number(n) * 100) / 100;

const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ------------------------------ schema guard ------------------------------ */
let schemaOk = false;
async function ready() {
  if (schemaOk) return true;
  const [a, b, c] = await Promise.all([
    supabase.from('shop_packs').select('id').limit(1),
    supabase.from('shop_orders').select('id').limit(1),
    supabase.from('users').select('premium_until').limit(1),
  ]);
  schemaOk = !a.error && !b.error && !c.error;   // a failed check is not remembered: the migration works without a restart
  return schemaOk;
}
const NOT_READY = 'The shop is not set up yet (run db/migration_shop.sql).';

/* --------------------------------- packs ---------------------------------- */
function kindOf(p) {
  if (p.grants_premium && Number(p.credits_usd) > 0) return 'bundle';
  return p.grants_premium ? 'premium' : 'credits';
}

function mapPack(p) {
  const price = Number(p.price_usd);
  const credits = Number(p.credits_usd);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    tagline: p.tagline || '',
    kind: p.kind,
    price,
    credits,
    bonusPct: credits > price && !p.grants_premium ? Math.round((credits / price - 1) * 100) : 0,
    premium: p.grants_premium ? { days: p.premium_days || null, lifetime: !p.premium_days } : null,
    boostPrice: p.premium_boost_price !== null && p.premium_boost_price !== undefined ? Number(p.premium_boost_price) : null,
    badge: p.badge || '',
    accent: /^#[0-9a-f]{6}$/i.test(p.accent || '') ? p.accent : KIND_ACCENT[p.kind] || KIND_ACCENT.bundle,
    features: Array.isArray(p.features) ? p.features.map(String) : [],
    sortOrder: p.sort_order || 0,
    active: Boolean(p.active),
  };
}

async function listPacks({ all = false } = {}) {
  let q = supabase.from('shop_packs').select('*').order('sort_order', { ascending: true }).order('price_usd', { ascending: true });
  if (!all) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(mapPack);
}

async function getPack(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const { data } = await supabase.from('shop_packs').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// Validates an admin's pack form. Throws a 400 with a readable message.
function validatePack(input = {}) {
  const b = input || {};
  const text = (v, max, label, required) => {
    const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (required && !s) throw httpError(400, `${label} is required`);
    if (s.length > max) throw httpError(400, `${label} can be at most ${max} characters`);
    return s;
  };
  const name = text(b.name, 60, 'Name', true);
  const tagline = text(b.tagline, 120, 'Tagline', false);
  const badge = text(b.badge, 24, 'Badge', false);

  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0.5 || price > 10000) throw httpError(400, 'Price must be between $0.50 and $10,000');
  const credits = b.credits === undefined || b.credits === '' || b.credits === null ? 0 : Number(b.credits);
  if (!Number.isFinite(credits) || credits < 0 || credits > 100000) throw httpError(400, 'Credits must be between $0 and $100,000');
  const grantsPremium = Boolean(b.grantsPremium);
  if (!grantsPremium && credits <= 0) throw httpError(400, 'A pack must give premium, credits, or both');

  let days = null;
  if (grantsPremium && b.premiumDays !== undefined && b.premiumDays !== null && b.premiumDays !== '') {
    days = Number(b.premiumDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw httpError(400, 'Premium days must be a whole number between 1 and 3650 (empty = lifetime)');
  }
  let boostPrice = null;
  if (grantsPremium && b.boostPrice !== undefined && b.boostPrice !== null && b.boostPrice !== '') {
    boostPrice = Number(b.boostPrice);
    if (!Number.isFinite(boostPrice) || boostPrice < 0 || boostPrice > 100) throw httpError(400, 'Boost price must be between 0 and 100');
  }
  let accent = null;
  if (b.accent) {
    accent = String(b.accent).trim();
    if (!/^#[0-9a-f]{6}$/i.test(accent)) throw httpError(400, 'Color must look like #ffb020');
  }
  let features = [];
  if (Array.isArray(b.features)) features = b.features;
  else if (typeof b.features === 'string') features = b.features.split(/\r?\n/);
  features = features.map((f) => text(f, 80, 'A feature', false)).filter(Boolean);
  if (features.length > 8) throw httpError(400, 'At most 8 features per pack');
  const sort = b.sortOrder === undefined || b.sortOrder === '' ? 0 : Number(b.sortOrder);
  if (!Number.isInteger(sort) || sort < -1000 || sort > 100000) throw httpError(400, 'Order must be a whole number');

  const row = {
    name, tagline: tagline || null, badge: badge || null, accent,
    price_usd: cents(price), credits_usd: cents(credits),
    grants_premium: grantsPremium, premium_days: days, premium_boost_price: boostPrice,
    features, sort_order: sort, active: b.active === undefined ? true : Boolean(b.active),
  };
  row.kind = kindOf(row);
  return row;
}

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pack';

async function createPack(input) {
  const row = validatePack(input);
  const base = slugify(row.name);
  for (let i = 0; i < 6; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const { data, error } = await supabase.from('shop_packs').insert({ ...row, slug }).select('*').single();
    if (!error) return mapPack(data);
    if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  throw httpError(409, 'Could not find a free name for this pack');
}

async function updatePack(id, input) {
  const row = validatePack(input);
  const { data, error } = await supabase.from('shop_packs')
    .update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(404, 'Pack not found');
  return mapPack(data);
}

async function deletePack(id) {
  const { error } = await supabase.from('shop_packs').delete().eq('id', id);
  if (error) throw error;
}

/* ------------------------------ premium state ----------------------------- */
// Premium ended on its date: switch the flag off (stock, keys and pages are kept; the
// panel is simply locked until it is renewed). Per account (userId) or for everybody.
async function expirePremiums(userId) {
  try {
    let q = supabase.from('users').update({ reseller: false })
      .eq('reseller', true).not('premium_until', 'is', null).lt('premium_until', new Date().toISOString());
    if (userId) q = q.eq('id', userId);
    const { error } = await q;
    return !error;
  } catch { return false; }
}

function premiumView(u) {
  const active = Boolean(u && u.reseller);
  const until = u && u.premium_until ? new Date(u.premium_until).toISOString() : null;
  return { active, lifetime: active && !until, until: active ? until : null };
}

async function userState(userId) {
  await expirePremiums(userId);
  const { data: u } = await supabase.from('users').select('id, username, balance, reseller, premium_until').eq('id', userId).maybeSingle();
  if (!u) return null;
  return { username: u.username, balance: Number(u.balance || 0), premium: premiumView(u) };
}

/* --------------------------------- balance -------------------------------- */
// Optimistic update: only writes if the balance is still what was read (retries a few times),
// so a deposit credited at the same moment is never overwritten.
async function adjustBalance(userId, delta, { minBefore = null } = {}) {
  for (let i = 0; i < 5; i += 1) {
    const { data: u } = await supabase.from('users').select('balance, reseller, premium_until, boost_price').eq('id', userId).maybeSingle();
    if (!u) throw httpError(404, 'Account not found');
    const before = Number(u.balance || 0);
    if (minBefore !== null && before + 1e-9 < minBefore) return { ok: false, reason: 'insufficient_funds', balance: before, user: u };
    const after = Math.max(0, MONEY(before + delta));
    const { data: done } = await supabase.from('users').update({ balance: after }).eq('id', userId).eq('balance', u.balance).select('id');
    if (done && done.length) return { ok: true, before, balance: after, user: u };
  }
  throw httpError(409, 'Your balance changed while paying — please try again.');
}

/* --------------------------------- orders --------------------------------- */
function mapOrder(o) {
  return {
    id: o.id,
    packId: o.pack_id || null,
    pack: o.pack_name,
    price: Number(o.price_usd),
    credits: Number(o.credits_usd),
    premium: o.grants_premium ? { days: o.premium_days || null, lifetime: !o.premium_days } : null,
    method: o.method,
    status: o.status,
    premiumUntil: o.premium_until || null,
    depositId: o.deposit_id || null,
    createdAt: o.created_at,
    completedAt: o.completed_at || null,
  };
}

const snapshot = (pack) => ({
  pack_id: pack.id,
  pack_name: pack.name,
  price_usd: pack.price_usd,
  credits_usd: pack.credits_usd,
  grants_premium: pack.grants_premium,
  premium_days: pack.premium_days,
  premium_boost_price: pack.premium_boost_price,
});

async function createOrder(userId, pack, method, extra = {}) {
  const { data, error } = await supabase.from('shop_orders')
    .insert({ user_id: userId, method, status: 'awaiting_payment', ...snapshot(pack), ...extra }).select('*').single();
  if (error) throw error;
  return data;
}

// Closes the account's unpaid Litecoin orders that are older than a day.
async function closeStaleOrders(userId) {
  await supabase.from('shop_orders').update({ status: 'cancelled' })
    .eq('user_id', userId).eq('status', 'awaiting_payment').lt('created_at', new Date(Date.now() - ORDER_TTL_MS).toISOString());
}

async function countOpenOrders(userId) {
  const { count } = await supabase.from('shop_orders').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'awaiting_payment');
  return count || 0;
}

function premiumPatch(user, order, now = Date.now()) {
  const was = Boolean(user.reseller);
  const cur = user.premium_until ? new Date(user.premium_until).getTime() : null;
  let until;
  if (was && cur === null) until = null;                         // already unlimited: never shortened
  else if (!order.premium_days) until = null;                    // lifetime
  else until = new Date((was && cur && cur > now ? cur : now) + order.premium_days * DAY_MS);   // renewals stack
  const patch = { reseller: true, premium_until: until ? until.toISOString() : null };
  if (!was && order.premium_boost_price !== null && order.premium_boost_price !== undefined) patch.boost_price = Number(order.premium_boost_price);
  return patch;
}

/**
 * Pays an order from the wallet: price out, credits in, premium granted.
 * Returns { done: true, order, balance, premium } or { done: false, reason }.
 * Safe to call twice: only one caller can claim an awaiting order.
 */
// A Litecoin payment may land a few cents under the price because the rate moved: that counts as paid.
const LTC_TOLERANCE_USD = 0.02;

/**
 * How much of an order's price its Litecoin deposit still lacks (USD). A top-up deposit is made for
 * exactly what was missing, so the part already paid is price - usd_amount.
 */
function missingUsd(order, dep) {
  const price = Number(order.price_usd);
  if (!dep) return price;
  const asked = Number(dep.usd_amount) || price;
  const ltc = Number(dep.amount) || 0;
  const got = ltc > 0 ? asked * ((Number(dep.received) || 0) / ltc) : 0;
  const left = Math.max(0, Number((asked - got).toFixed(2)));
  return left <= LTC_TOLERANCE_USD ? 0 : left;
}

async function fulfillOrder(orderId, opts = {}) {
  // `revive`: a Litecoin order that expired (24 h) but whose payment arrived anyway is still delivered.
  const from = opts.revive ? ['awaiting_payment', 'cancelled'] : ['awaiting_payment'];
  const { data: order } = await supabase.from('shop_orders')
    .update({ status: 'processing' }).eq('id', orderId).in('status', from).select('*').maybeSingle();
  if (!order) return { done: false, reason: 'not_pending' };

  const release = () => supabase.from('shop_orders').update({ status: 'awaiting_payment' }).eq('id', orderId);
  try {
    const price = Number(order.price_usd);
    const credits = Number(order.credits_usd);
    // Litecoin orders get a few cents of slack (rate drift); a wallet order must cover the full price.
    const slack = order.method === 'ltc' ? LTC_TOLERANCE_USD : 0;
    const paid = await adjustBalance(order.user_id, credits - price, { minBefore: price - slack });
    if (!paid.ok) { await release(); return { done: false, reason: 'insufficient_funds', balance: paid.balance }; }

    let premiumUntil = null;
    if (order.grants_premium) {
      try {
        const patch = premiumPatch(paid.user, order);
        const { error } = await supabase.from('users').update(patch).eq('id', order.user_id);
        if (error) throw error;
        premiumUntil = patch.premium_until;
      } catch (err) {
        await adjustBalance(order.user_id, price - credits).catch(() => {});   // give the money back
        await release();
        throw err;
      }
    }
    const { data: done } = await supabase.from('shop_orders')
      .update({ status: 'completed', completed_at: new Date().toISOString(), premium_until: premiumUntil })
      .eq('id', orderId).select('*').single();
    const state = await userState(order.user_id);
    return { done: true, order: done || order, balance: state ? state.balance : paid.balance, premium: state ? state.premium : null };
  } catch (err) {
    await release();   // never leave an order stuck in "processing"
    throw err;
  }
}

// A Litecoin deposit was just confirmed (called by the wallet): finish the order that was waiting for it.
async function onDepositCompleted(depositId) {
  if (!depositId) return null;
  const { data: order } = await supabase.from('shop_orders').select('id').eq('deposit_id', depositId).in('status', ['awaiting_payment', 'cancelled']).maybeSingle();
  return order ? fulfillOrder(order.id, { revive: true }) : null;
}

// Safety net: checks the Litecoin deposits that are still pending (a customer may close the page, or the
// webhook may not be set up), so a payment is always picked up and its order delivered.
async function syncPendingDeposits(limit = 10) {
  const wallet = require('../routes/wallet');
  if (!wallet.tatum.isConfigured()) return 0;
  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const { data } = await supabase.from('deposits').select('*').eq('status', 'pending').gt('created_at', since).order('created_at', { ascending: false }).limit(limit);
  let n = 0;
  for (const dep of data || []) {
    try { const r = await wallet.processDeposit(dep); if (r && r.status === 'completed') n += 1; } catch { /* next cycle */ }
  }
  return n;
}

async function listOrders(userId, limit = 20) {
  const { data } = await supabase.from('shop_orders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  return (data || []).map(mapOrder);
}

async function getOrder(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const { data } = await supabase.from('shop_orders').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data || null;
}

/* ---------------------------------- admin --------------------------------- */
async function adminOverview() {
  const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [packs, orders, recent] = await Promise.all([
    listPacks({ all: true }),
    supabase.from('shop_orders').select('price_usd, credits_usd, grants_premium, created_at, status').eq('status', 'completed').limit(50000),
    supabase.from('shop_orders').select('*').order('created_at', { ascending: false }).limit(60),
  ]);
  const done = orders.data || [];
  const sum = (rows) => cents(rows.reduce((n, o) => n + Number(o.price_usd), 0));
  const last30 = done.filter((o) => o.created_at >= since30);
  const ids = [...new Set((recent.data || []).map((o) => o.user_id))];
  let names = {};
  if (ids.length) {
    const { data: us } = await supabase.from('users').select('id, username').in('id', ids);
    names = Object.fromEntries((us || []).map((u) => [u.id, u.username]));
  }
  return {
    packs,
    stats: {
      orders: done.length, revenue: sum(done),
      orders30d: last30.length, revenue30d: sum(last30),
      premiumSold: done.filter((o) => o.grants_premium).length,
      creditsGiven: cents(done.reduce((n, o) => n + Number(o.credits_usd), 0)),
    },
    orders: (recent.data || []).map((o) => ({ ...mapOrder(o), user: names[o.user_id] || '—' })),
  };
}

module.exports = {
  ready, NOT_READY, httpError,
  mapPack, listPacks, getPack, validatePack, createPack, updatePack, deletePack,
  expirePremiums, premiumView, userState, premiumPatch,
  adjustBalance, createOrder, closeStaleOrders, countOpenOrders, fulfillOrder, onDepositCompleted,
  listOrders, getOrder, mapOrder, adminOverview, syncPendingDeposits,
  MAX_OPEN_ORDERS, LTC_TOLERANCE_USD, missingUsd,
};
