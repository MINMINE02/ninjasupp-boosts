'use strict';

/**
 * Reseller logic shared by the dashboard routes (JWT) and the public API
 * (API key). A reseller is a normal account the admin has switched on: they
 * get their OWN stock tokens and their OWN redeem keys. Rows are scoped with
 * `owner_id` (NULL = the admin's own pool), so nothing crosses over.
 */

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { generateKeyCode, parseCredentialList } = require('../utils/helpers');

const BOOSTS_PER_TOKEN = Math.max(1, Math.round(Number(process.env.BOOSTS_PER_TOKEN) || 2));
const MAX_KEYS_PER_CALL = 500;
const MAX_STOCK_PER_CALL = 5000;
const HEAD = { count: 'exact', head: true };

const fail = (status, message) => Object.assign(new Error(message), { status });

async function count(q) {
  const { count: c, error } = await q;
  if (error) throw error;
  return c || 0;
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 12) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** Counters used by the sidebar, the overview and the API. */
async function summary(ownerId) {
  const [stockUnused, stockUsed, keysTotal, keysUnused, unusedKeys, jobs] = await Promise.all([
    count(supabase.from('stock_tokens').select('*', HEAD).eq('owner_id', ownerId).eq('status', 'unused')),
    count(supabase.from('stock_tokens').select('*', HEAD).eq('owner_id', ownerId).eq('status', 'used')),
    count(supabase.from('redeem_keys').select('*', HEAD).eq('owner_id', ownerId)),
    count(supabase.from('redeem_keys').select('*', HEAD).eq('owner_id', ownerId).is('redeemed_at', null)),
    supabase.from('redeem_keys').select('boosts_value, boosts_delivered').eq('owner_id', ownerId).is('redeemed_at', null).limit(20000),
    supabase.from('jobs').select('boosts_delivered').eq('owner_id', ownerId).neq('mode', 'join').limit(50000),
  ]);
  const owed = (unusedKeys.data || []).reduce((n, k) => n + Math.max(0, k.boosts_value - (k.boosts_delivered || 0)), 0);
  return {
    stock: { unused: stockUnused, used: stockUsed, tokensNeeded: Math.ceil(owed / BOOSTS_PER_TOKEN), boostsPerToken: BOOSTS_PER_TOKEN },
    keys: { total: keysTotal, unused: keysUnused, redeemed: keysTotal - keysUnused, owedBoosts: owed },
    boostsDelivered: (jobs.data || []).reduce((n, j) => n + (j.boosts_delivered || 0), 0),
  };
}

async function generateKeys(ownerId, { boosts, count: n, note }) {
  boosts = Number(boosts);
  n = Number(n === undefined || n === null || n === '' ? 1 : n);
  if (!Number.isInteger(boosts) || boosts < 1 || boosts > 1000) throw fail(400, 'Boosts per key must be a whole number between 1 and 1000');
  if (!Number.isInteger(n) || n < 1 || n > MAX_KEYS_PER_CALL) throw fail(400, `Number of keys must be between 1 and ${MAX_KEYS_PER_CALL}`);
  const cleanNote = String(note || '').trim().slice(0, 120) || null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seen = new Set();
    const rows = [];
    while (rows.length < n) {
      const code = generateKeyCode();
      if (seen.has(code)) continue;
      seen.add(code);
      rows.push({ code, boosts_value: boosts, source: 'reseller', note: cleanNote, owner_id: ownerId });
    }
    const { data, error } = await supabase.from('redeem_keys').insert(rows).select('code, boosts_value, created_at');
    if (!error) return data.map((k) => ({ code: k.code, boosts: k.boosts_value, createdAt: k.created_at }));
    if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  throw fail(500, 'Could not generate unique keys, please try again');
}

async function listKeys(ownerId, { status, limit = 1000 } = {}) {
  let q = supabase
    .from('redeem_keys')
    .select('code, boosts_value, boosts_delivered, redeemed_at, redeemed_invite, note, source, server_link, created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(Math.min(5000, Number(limit) || 1000));
  if (status === 'unused') q = q.is('redeemed_at', null);
  else if (status === 'redeemed') q = q.not('redeemed_at', 'is', null);
  const { data, error } = await q;
  if (error) throw error;
  // A direct boost ("boost with my stock") is stored as a one-off key. Once it
  // is fully delivered it is just history (see Orders) — hide it here. A partly
  // delivered one stays visible: its remainder is a usable key.
  const visible = (data || []).filter(
    (k) => !(k.source === 'direct' && k.redeemed_at && (Number(k.boosts_delivered) || 0) >= Number(k.boosts_value)),
  );
  return visible.map((k) => ({
    code: k.code,
    boosts: k.boosts_value,
    delivered: k.boosts_delivered || 0,
    redeemed: Boolean(k.redeemed_at),
    redeemedAt: k.redeemed_at,
    server: k.redeemed_invite || null,
    note: k.note || '',
    source: k.source || 'reseller',
    serverLink: k.server_link || '',
    createdAt: k.created_at,
  }));
}

/** Adds tokens to the reseller's own stock (bare token or email:pass:token). */
async function addStock(ownerId, input) {
  const creds = parseCredentialList(input);
  if (!creds.length) throw fail(400, 'No tokens provided');
  if (creds.length > MAX_STOCK_PER_CALL) throw fail(400, `Add at most ${MAX_STOCK_PER_CALL} tokens at a time`);
  const rows = creds.map(({ token, line }) => ({
    token,
    full_line: line !== token ? line : null,
    status: 'unused',
    owner_id: ownerId,
  }));
  // A token already present anywhere on the platform is skipped (tokens are unique).
  const { data, error } = await supabase
    .from('stock_tokens')
    .upsert(rows, { onConflict: 'token', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;
  const inserted = data?.length ?? 0;
  return { inserted, submitted: creds.length, duplicates: creds.length - inserted };
}

/* ------------------------------ API keys ------------------------------- */
const hashApiKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

function newApiKey() {
  const key = `nbk_${crypto.randomBytes(24).toString('hex')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

module.exports = {
  BOOSTS_PER_TOKEN, MAX_KEYS_PER_CALL, fail, maskToken,
  summary, generateKeys, listKeys, addStock, hashApiKey, newApiKey,
};
