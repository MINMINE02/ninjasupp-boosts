'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin, signToken, JWT_SECRET } = require('../middleware/auth');
const { asyncHandler, generateKeyCode, parseCredentialList, extractToken } = require('../utils/helpers');
const checker = require('../services/checker');
const { getConfig, setConfig } = require('../services/config');
const { getSettings, updateSettings } = require('../services/settings');
const { rateLimit } = require('../utils/rateLimit');

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 12) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

// Resolve a Discord invite code to its server (guild) name, cached in-memory
// so listing the token table doesn't hammer Discord (and survives expired
// invites by falling back to null -> the UI then shows the code).
const guildNameCache = new Map(); // code -> { name, at }
const GUILD_NAME_TTL_MS = 5 * 60 * 1000;
async function resolveGuildName(code) {
  if (!code) return null;
  const cached = guildNameCache.get(code);
  if (cached && Date.now() - cached.at < GUILD_NAME_TTL_MS) return cached.name;

  let name = null;
  try {
    const r = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`,
      { headers: { 'User-Agent': 'Ninja Boost (https://ninja-boost, 1.0)' } }
    );
    if (r.ok) {
      const data = await r.json();
      name = data?.guild?.name || null;
    }
  } catch { /* network hiccup — fall back to the code */ }

  guildNameCache.set(code, { name, at: Date.now() });
  return name;
}

const router = express.Router();

// Extra password gate for the admin dashboard (on top of the admin role). No
// fallback here on purpose — a guessable default defeats the whole point of
// a second gate. Refuse to start rather than run with a known password.
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD;
if (!ADMIN_PANEL_PASSWORD) {
  throw new Error(
    'ADMIN_PANEL_PASSWORD is not set. Refusing to start — set a strong, ' +
    'unique ADMIN_PANEL_PASSWORD in the environment before running the server.'
  );
}

// The admin login (auth.js) + admin role is the first gate — every admin
// route requires an authenticated admin account.
router.use(requireAuth, requireAdmin);

// POST /api/admin/unlock — verify the admin panel password (second factor)
// and hand back a short-lived signed panel token. Every admin route BELOW this
// point requires that token (X-Panel-Token header), so the second password is
// enforced by the server and not only by the browser UI. Rate-limited so it
// can't be brute-forced even with a valid admin login.
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const unlockLimiter = rateLimit({ windowMs: 60_000, max: 10 });
router.post('/unlock', unlockLimiter, (req, res) => {
  const ok = crypto.timingSafeEqual(digest(req.body?.password || ''), digest(ADMIN_PANEL_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Incorrect admin password' });
  const panelToken = jwt.sign({ sub: req.user.id, panel: true }, JWT_SECRET, { expiresIn: '8h' });
  return res.json({ ok: true, panelToken });
});

function requirePanel(req, res, next) {
  const raw = req.get('X-Panel-Token') || '';
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    if (payload.panel === true && payload.sub === req.user.id) return next();
  } catch { /* fall through */ }
  return res.status(403).json({ error: 'Admin panel is locked', locked: true });
}
router.use(requirePanel);

// Extra admin tools (search, account sheets, deposits, insights, system, activity log).
router.use(require('./adminTools'));

// ---------------------------------------------------------------------------
// Admin credentials
// ---------------------------------------------------------------------------

// PATCH /api/admin/credentials — change the admin's own username and password.
// Instead of editing the existing row, this deletes the current admin account
// and creates a brand-new admin account with the changed data, then returns a
// fresh session token so the admin isn't logged out by the swap. Already gated
// by requireAuth + requireAdmin above.
//
// The env ADMIN_USERNAME/ADMIN_PASSWORD are only a first-run bootstrap seed
// (services/bootstrap.js seeds only when no admin exists), so this change
// survives restarts instead of being recreated/reset from the env.
const ADMIN_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
router.patch(
  '/credentials',
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username == null ? '' : req.body.username).trim();
    if (!username) return res.status(400).json({ error: 'Username is required' });
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 3\u201332 characters' });
    }
    if (!ADMIN_USERNAME_RE.test(username)) {
      return res.status(400).json({
        error:
          'Username may only contain letters, numbers, and . _ - ' +
          '(and must start with a letter or number)',
      });
    }

    const password = String(req.body?.password || '');
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // The new username may only clash with the admin's own current account
    // (which we're about to delete) — never with someone else's.
    const { data: clash } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .neq('id', req.user.id)
      .maybeSingle();
    if (clash) return res.status(409).json({ error: 'Username already taken' });

    const password_hash = await bcrypt.hash(password, 10);

    // Delete the old admin account first, then create the new one — deleting
    // first lets a password-only change (same username) reuse the name.
    const { error: delErr } = await supabase.from('users').delete().eq('id', req.user.id);
    if (delErr) throw delErr;

    const { data: created, error: insErr } = await supabase
      .from('users')
      .insert({ username, password_hash, role: 'admin' })
      .select('id, username, role, balance, created_at')
      .single();
    if (insErr) throw insErr;

    const token = signToken(created);
    // The account id changed, so the old panel token no longer matches — issue one for the new account.
    const panelToken = jwt.sign({ sub: created.id, panel: true }, JWT_SECRET, { expiresIn: '8h' });
    res.json({
      panelToken,
      message: 'Admin account updated \u2014 old account removed, new one created',
      token,
      user: {
        id: created.id,
        username: created.username,
        role: created.role,
        balance: Number(created.balance ?? 0),
        createdAt: created.created_at,
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Stock tokens
// ---------------------------------------------------------------------------

// POST /api/admin/tokens — bulk upload stock tokens (one per line). Accepts
// bare tokens or full `email:pass:token` lines; the full line is kept
// alongside the extracted token so it can be copied back out later exactly
// as it was pasted in.
router.post(
  '/tokens',
  asyncHandler(async (req, res) => {
    const creds = parseCredentialList(req.body?.tokens);
    if (creds.length === 0) {
      return res.status(400).json({ error: 'No tokens provided' });
    }

    const rows = creds.map(({ token, line }) => ({
      token,
      full_line: line !== token ? line : null,
      status: 'unused',
    }));
    const { data, error } = await supabase
      .from('stock_tokens')
      .upsert(rows, { onConflict: 'token', ignoreDuplicates: true })
      .select('id');

    if (error) throw error;

    res.status(201).json({
      message: `Saved ${data?.length ?? 0} new tokens`,
      inserted: data?.length ?? 0,
      submitted: creds.length,
    });
  })
);

// GET /api/admin/tokens — list stock tokens (masked) with status + counts.
router.get(
  '/tokens',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('stock_tokens')
      .select('id, token, status, created_at, used_at, used_by_job')
      .is('owner_id', null)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    // Resolve which server each used token boosted: used_by_job -> jobs.invite.
    const jobIds = [...new Set((data || []).map((t) => t.used_by_job).filter(Boolean))];
    let inviteByJob = {};
    if (jobIds.length) {
      const { data: jobs } = await supabase
        .from('jobs')
        .select('id, invite')
        .in('id', jobIds);
      inviteByJob = Object.fromEntries((jobs || []).map((j) => [j.id, j.invite]));
    }

    // Resolve each distinct invite to its real Discord server name (cached).
    const uniqueInvites = [...new Set(Object.values(inviteByJob).filter(Boolean))];
    const nameByInvite = {};
    await Promise.all(
      uniqueInvites.map(async (code) => { nameByInvite[code] = await resolveGuildName(code); })
    );

    const tokens = (data || []).map((t) => {
      const invite = t.used_by_job ? (inviteByJob[t.used_by_job] || null) : null;
      return {
        id: t.id,
        preview: maskToken(t.token),
        status: t.status,
        createdAt: t.created_at,
        usedAt: t.used_at,
        server: invite,
        serverName: invite ? (nameByInvite[invite] || null) : null,
      };
    });
    const unused = tokens.filter((t) => t.status === 'unused').length;

    res.json({ tokens, total: tokens.length, unused, used: tokens.length - unused });
  })
);

// GET /api/admin/tokens/export?status=unused|used — full credential lines
// (email:pass:token as originally pasted, or the bare token if that's all
// there was) for bulk copy/edit. Admin-only, already gated above.
router.get(
  '/tokens/export',
  asyncHandler(async (req, res) => {
    const status = ['unused', 'used'].includes(req.query?.status) ? req.query.status : null;
    let query = supabase
      .from('stock_tokens')
      .select('token, full_line')
      .is('owner_id', null)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query.limit(5000);
    if (error) throw error;
    res.json({ tokens: (data || []).map((t) => t.full_line || t.token) });
  })
);

// GET /api/admin/tokens/:id/raw — the single full credential line, for a
// per-row "copy" action (the list/table view only ever shows a masked
// preview).
router.get(
  '/tokens/:id/raw',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('stock_tokens')
      .select('token, full_line')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Token not found' });
    res.json({ token: data.full_line || data.token });
  })
);

// PATCH /api/admin/tokens/:id — edit a single token's value. `token` in the
// body is the full credential line the admin typed (bare token, or
// `email:pass:token`); the bare token is re-derived from it.
router.patch(
  '/tokens/:id',
  asyncHandler(async (req, res) => {
    const line = String(req.body?.token || '').trim();
    const bare = extractToken(line);
    if (!bare) return res.status(400).json({ error: 'Token value is required' });

    const { data: existing } = await supabase
      .from('stock_tokens')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Token not found' });

    const { data: updated, error } = await supabase
      .from('stock_tokens')
      .update({ token: bare, full_line: line !== bare ? line : null })
      .eq('id', req.params.id)
      .select('id, token, full_line, status, created_at, used_at')
      .single();

    if (error) {
      if (/duplicate|unique/i.test(error.message || '')) {
        return res.status(409).json({ error: 'That token already exists in stock' });
      }
      throw error;
    }

    res.json({
      message: 'Token updated',
      token: {
        id: updated.id,
        preview: maskToken(updated.token),
        status: updated.status,
        createdAt: updated.created_at,
        usedAt: updated.used_at,
      },
    });
  })
);

// PUT /api/admin/tokens/unused — replace the UNUSED stock pool with exactly
// the credential lines in the given text: lines whose token isn't currently
// present are added, currently-unused tokens no longer present are removed,
// and a line whose token already exists but whose full text changed (e.g.
// the email/pass around it was fixed) updates that row in place instead of
// delete+recreate, preserving its id. This is the "edit as one big text
// field" bulk operation. Used tokens are never touched here — they're tied
// to job history via used_by_job and must stay put.
router.put(
  '/tokens/unused',
  asyncHandler(async (req, res) => {
    const creds = parseCredentialList(req.body?.tokens);
    const newByToken = new Map(creds.map((c) => [c.token, c.line]));

    const { data: current, error: curErr } = await supabase
      .from('stock_tokens')
      .select('id, token, full_line')
      .is('owner_id', null)
      .eq('status', 'unused');
    if (curErr) throw curErr;

    const currentByToken = new Map((current || []).map((r) => [r.token, r]));

    const toAdd = [...newByToken.entries()].filter(([token]) => !currentByToken.has(token));
    const toRemove = (current || []).filter((r) => !newByToken.has(r.token));
    const toUpdate = (current || []).filter((r) => {
      if (!newByToken.has(r.token)) return false;
      const newLine = newByToken.get(r.token);
      const currentLine = r.full_line || r.token;
      return newLine !== currentLine;
    });

    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('stock_tokens')
        .delete()
        .in('id', toRemove.map((r) => r.id));
      if (error) throw error;
    }
    if (toAdd.length > 0) {
      const rows = toAdd.map(([token, line]) => ({
        token,
        full_line: line !== token ? line : null,
        status: 'unused',
      }));
      const { error } = await supabase
        .from('stock_tokens')
        .upsert(rows, { onConflict: 'token', ignoreDuplicates: true });
      if (error) throw error;
    }
    for (const r of toUpdate) {
      const line = newByToken.get(r.token);
      const { error } = await supabase
        .from('stock_tokens')
        .update({ full_line: line !== r.token ? line : null })
        .eq('id', r.id);
      if (error) throw error;
    }

    res.json({
      message: `Stock updated: +${toAdd.length} added, -${toRemove.length} removed, ${toUpdate.length} edited`,
      added: toAdd.length,
      removed: toRemove.length,
      updated: toUpdate.length,
    });
  })
);

// DELETE /api/admin/tokens — delete ALL stock tokens.
router.delete(
  '/tokens',
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('stock_tokens')
      .delete()
      .is('owner_id', null)
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    res.json({ message: 'All your stock tokens deleted (reseller stock is untouched)' });
  })
);

// DELETE /api/admin/tokens/:id — delete a single stock token.
router.delete(
  '/tokens/:id',
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('stock_tokens')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Token deleted' });
  })
);

// id -> username for a list of (possibly null) user ids.
async function usernamesById(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  const { data } = await supabase.from('users').select('id, username').in('id', uniq);
  return Object.fromEntries((data || []).map((u) => [u.id, u.username]));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

// POST /api/admin/keys — generate keys.
//   Bulk:     { boostsPerKey, count }        -> N keys, each worth boostsPerKey
//   Per-key:  { keys: [{ boosts }, ...] }    -> one key per entry, own boosts
router.post(
  '/keys',
  asyncHandler(async (req, res) => {
    let specs = [];
    const keyNote = String(req.body?.note || '').trim().slice(0, 120) || null;

    if (Array.isArray(req.body?.keys) && req.body.keys.length > 0) {
      // Explicit per-key boost amounts.
      specs = req.body.keys.map((k) => Number(k?.boosts));
    } else {
      // Bulk: the same boost amount for `count` keys.
      const boostsPerKey = Number(req.body?.boostsPerKey || 0);
      const count = Number(req.body?.count || 0);
      if (!Number.isInteger(count) || count < 1 || count > 500) {
        return res.status(400).json({ error: 'Number of keys must be between 1 and 500' });
      }
      specs = Array.from({ length: count }, () => boostsPerKey);
    }

    // Validate every boost amount.
    for (const boosts of specs) {
      if (!Number.isInteger(boosts) || boosts < 1) {
        return res.status(400).json({ error: 'Boosts per key must be a positive integer' });
      }
    }
    if (specs.length > 500) {
      return res.status(400).json({ error: 'Cannot generate more than 500 keys at once' });
    }

    // Build rows with unique 16-char codes.
    const rows = [];
    const seen = new Set();
    for (const boosts of specs) {
      let code;
      do {
        code = generateKeyCode();
      } while (seen.has(code));
      seen.add(code);
      rows.push({ code, boosts_value: boosts, source: 'admin', note: keyNote });
    }

    const { data, error } = await supabase
      .from('redeem_keys')
      .insert(rows)
      .select('code, boosts_value, created_at');

    if (error) throw error;

    res.status(201).json({
      message: `Generated ${data.length} key${data.length === 1 ? '' : 's'}`,
      keys: data.map((k) => ({
        code: k.code,
        boosts: k.boosts_value,
        createdAt: k.created_at,
      })),
    });
  })
);

// GET /api/admin/keys — list keys.
router.get(
  '/keys',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('redeem_keys')
      .select('code, boosts_value, boosts_delivered, redeemed_at, redeemed_invite, created_at, source, note, server_link, owner_id')
      .order('created_at', { ascending: false })
      .limit(2000);

    if (error) throw error;
    const owners = await usernamesById((data || []).map((k) => k.owner_id));

    res.json({
      keys: (data || []).map((k) => ({
        owner: k.owner_id ? owners[k.owner_id] || 'reseller' : null,
        code: k.code,
        boosts: k.boosts_value,
        redeemed: Boolean(k.redeemed_at),
        redeemedAt: k.redeemed_at,
        redeemedInvite: k.redeemed_invite,
        delivered: k.boosts_delivered || 0,
        source: k.source || 'admin',
        note: k.note || '',
        serverLink: k.server_link || '',
        createdAt: k.created_at,
      })),
    });
  })
);

// DELETE /api/admin/keys?scope=unused|redeemed|all — bulk delete keys.
router.delete(
  '/keys',
  asyncHandler(async (req, res) => {
    const scope = ['unused', 'redeemed', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    let q = supabase.from('redeem_keys').delete().is('owner_id', null);
    if (scope === 'unused') q = q.is('redeemed_at', null);
    else if (scope === 'redeemed') q = q.not('redeemed_at', 'is', null);
    else q = q.neq('code', '');
    const { error } = await q;
    if (error) throw error;
    res.json({ message: scope === 'all' ? 'All keys deleted' : `${scope} keys deleted` });
  })
);

// DELETE /api/admin/keys/:code — delete a single key.
router.delete(
  '/keys/:code',
  asyncHandler(async (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    const { error } = await supabase
      .from('redeem_keys')
      .delete()
      .eq('code', code);
    if (error) throw error;
    res.json({ message: 'Key deleted' });
  })
);

// ---------------------------------------------------------------------------
// Users (BYOT accounts)
// ---------------------------------------------------------------------------

// GET /api/admin/users — list all users.
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, role, balance, created_at, reseller, boost_price')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    res.json({
      users: (data || []).map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        balance: Number(u.balance || 0),
        reseller: Boolean(u.reseller),
        boostPrice: Number(u.boost_price || 0),
        createdAt: u.created_at,
      })),
    });
  })
);

// PATCH /api/admin/users/:id/balance — credit (or debit) a user's wallet.
router.patch(
  '/users/:id/balance',
  asyncHandler(async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'Amount must be a non-zero number' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, username, balance')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: 'User not found' });

    // 4dp, not 2 — the existing balance may carry fractions of a cent from
    // $0.015 captcha charges, and rounding the sum to cents would erase them.
    const newBalance = Math.max(0, Number((Number(user.balance || 0) + amount).toFixed(4)));
    const { data: updated, error } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('id', user.id)
      .select('id, username, balance')
      .single();

    if (error) throw error;

    res.json({
      message: `${amount > 0 ? 'Added' : 'Removed'} $${Math.abs(amount).toFixed(2)} ${amount > 0 ? 'to' : 'from'} ${updated.username}`,
      user: { id: updated.id, username: updated.username, balance: Number(updated.balance) },
    });
  })
);

// ---------------------------------------------------------------------------
// Settings — BYOT pricing + the support contact link
// ---------------------------------------------------------------------------

// GET /api/admin/settings — the solve price + the support contact link.
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const supportUrl = await getConfig('support_server_url');
    res.json({
      captchaCost: s.captcha_cost,
      supportUrl: supportUrl || '',
    });
  })
);

// PATCH /api/admin/settings — update the solve price and/or the support link.
router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const patch = {};
    if (req.body?.captchaCost !== undefined) patch.captcha_cost = req.body.captchaCost;

    // Optional support contact link (empty string clears it).
    if (req.body?.supportUrl !== undefined) {
      const url = String(req.body.supportUrl || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'Support link must start with http(s)://' });
      }
      await setConfig('support_server_url', url);
    }

    const captchaCost = Object.keys(patch).length
      ? (await updateSettings(patch)).captcha_cost
      : (await getSettings()).captcha_cost;

    res.json({
      message: 'Settings updated',
      settings: {
        captchaCost,
        supportUrl: (await getConfig('support_server_url')) || '',
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Token checker (platform's own stock)
// ---------------------------------------------------------------------------
router.get('/tokens/check', asyncHandler(async (req, res) => {
  res.json({ check: await checker.latest(null), max: checker.MAX_CHECK });
}));
router.post('/tokens/check', asyncHandler(async (req, res) => {
  const check = await checker.startCheck(null, req.body?.tokens);
  res.status(201).json({ message: `Checking ${check.submitted} tokens`, check });
}));
router.get('/tokens/check/:id', asyncHandler(async (req, res) => {
  res.json({ check: await checker.pollCheck(null, req.params.id) });
}));
router.get('/tokens/check/:id/results', asyncHandler(async (req, res) => {
  res.json(await checker.results(null, req.params.id));
}));
router.post('/tokens/check/:id/import', asyncHandler(async (req, res) => {
  const r = await checker.importTokens(null, req.params.id, req.body?.statuses);
  res.json({ message: `${r.added} token${r.added === 1 ? '' : 's'} added to your stock`, ...r });
}));
router.post('/tokens/check/:id/purge', asyncHandler(async (req, res) => {
  const r = await checker.purge(null, req.params.id, req.body?.statuses);
  res.json({ message: `${r.deleted} token${r.deleted === 1 ? '' : 's'} deleted`, ...r });
}));

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------
const BOOSTS_PER_TOKEN = Math.max(1, Math.round(Number(process.env.BOOSTS_PER_TOKEN) || 2));
const count = async (q) => {
  const { count: c, error } = await q;
  if (error) throw error;
  return c || 0;
};

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const head = { count: 'exact', head: true };
    const since14 = new Date(Date.now() - 14 * 86400000).toISOString();
    const since24 = new Date(Date.now() - 86400000).toISOString();

    const [keysTotal, keysUnused, stockUnused, stockUsed, usersTotal, saTotal, saDay, unusedKeys, jobsRecent, balances, resTotal, resStock, resKeys] =
      await Promise.all([
        count(supabase.from('redeem_keys').select('*', head).is('owner_id', null)),
        count(supabase.from('redeem_keys').select('*', head).is('owner_id', null).is('redeemed_at', null)),
        count(supabase.from('stock_tokens').select('*', head).is('owner_id', null).eq('status', 'unused')),
        count(supabase.from('stock_tokens').select('*', head).is('owner_id', null).eq('status', 'used')),
        count(supabase.from('users').select('*', head).eq('role', 'user')),
        count(supabase.from('sellauth_deliveries').select('*', head).is('owner_id', null).eq('status', 'delivered')),
        count(supabase.from('sellauth_deliveries').select('*', head).is('owner_id', null).eq('status', 'delivered').gte('created_at', since24)),
        supabase.from('redeem_keys').select('boosts_value, boosts_delivered').is('owner_id', null).is('redeemed_at', null).limit(20000),
        supabase.from('jobs').select('status, mode, boosts_delivered, boosts_requested, created_at').gte('created_at', since14).limit(5000),
        supabase.from('users').select('balance').eq('role', 'user').limit(20000),
        count(supabase.from('users').select('*', head).eq('reseller', true)),
        count(supabase.from('stock_tokens').select('*', head).not('owner_id', 'is', null).eq('status', 'unused')),
        count(supabase.from('redeem_keys').select('*', head).not('owner_id', 'is', null).is('redeemed_at', null)),
      ]);

    const owedBoosts = (unusedKeys.data || []).reduce((n, k) => n + Math.max(0, k.boosts_value - (k.boosts_delivered || 0)), 0);
    const tokensNeeded = Math.ceil(owedBoosts / BOOSTS_PER_TOKEN);

    const jobs = jobsRecent.data || [];
    const byStatus = {};
    const days = {};
    for (let i = 13; i >= 0; i -= 1) days[new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)] = { jobs: 0, boosts: 0 };
    let boosts24 = 0;
    for (const j of jobs) {
      byStatus[j.status] = (byStatus[j.status] || 0) + 1;
      const day = String(j.created_at).slice(0, 10);
      // A join counts accounts joined, not boosts — keep it out of the boost totals.
      const b = j.mode === 'join' ? 0 : j.boosts_delivered || 0;
      if (days[day]) { days[day].jobs += 1; days[day].boosts += b; }
      if (j.created_at >= since24) boosts24 += b;
    }

    res.json({
      keys: { total: keysTotal, unused: keysUnused, redeemed: keysTotal - keysUnused, owedBoosts },
      stock: { unused: stockUnused, used: stockUsed, tokensNeeded, boostsPerToken: BOOSTS_PER_TOKEN },
      users: { total: usersTotal, walletTotal: (balances.data || []).reduce((n, u) => n + Number(u.balance || 0), 0) },
      sellauth: { delivered: saTotal, last24h: saDay },
      resellers: { total: resTotal, stockUnused: resStock, keysUnused: resKeys },
      jobs: { byStatus, boosts24h: boosts24, series: Object.entries(days).map(([date, v]) => ({ date, ...v })) },
    });
  })
);

// GET /api/admin/jobs — latest boost jobs (key + BYOT).
router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 100));
    const { data, error } = await supabase
      .from('jobs')
      .select('id, mode, invite, status, boosts_requested, boosts_delivered, tokens_used, cost, retry_count, created_at, updated_at, owner_id, users(username), redeem_keys(code)')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const owners = await usernamesById((data || []).map((j) => j.owner_id));
    res.json({
      jobs: (data || []).map((j) => ({
        owner: j.owner_id ? owners[j.owner_id] || 'reseller' : null,
        id: j.id,
        mode: j.mode,
        invite: j.invite,
        status: j.status,
        requested: j.boosts_requested,
        delivered: j.boosts_delivered,
        tokens: j.tokens_used,
        cost: Number(j.cost || 0),
        retries: j.retry_count || 0,
        user: j.users?.username || null,
        key: j.redeem_keys?.code || null,
        createdAt: j.created_at,
        updatedAt: j.updated_at,
      })),
    });
  })
);

// DELETE /api/admin/users/:id — remove a (non-admin) account.
router.delete(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const { data: user } = await supabase.from('users').select('id, role, username').eq('id', req.params.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be deleted here' });
    const { error } = await supabase.from('users').delete().eq('id', user.id);
    if (error) throw error;
    res.json({ message: `Deleted ${user.username}` });
  })
);

// ---------------------------------------------------------------------------
// SellAuth dynamic delivery — config, product mapping, delivery log
// ---------------------------------------------------------------------------
router.get(
  '/sellauth',
  asyncHandler(async (req, res) => {
    const [{ data: products }, secretDb, defBoosts, linkField] = await Promise.all([
      supabase.from('sellauth_products').select('id, sellauth_id, label, boosts_value, created_at').is('owner_id', null).order('created_at', { ascending: false }),
      getConfig('sellauth_webhook_secret'),
      getConfig('sellauth_default_boosts'),
      getConfig('sellauth_link_field'),
    ]);
    res.json({
      secretSet: Boolean(process.env.SELLAUTH_WEBHOOK_SECRET || secretDb),
      secretFromEnv: Boolean(process.env.SELLAUTH_WEBHOOK_SECRET),
      defaultBoosts: Number(defBoosts) || 0,
      linkField: linkField || 'Server Link',
      products: (products || []).map((p) => ({ id: p.id, sellauthId: p.sellauth_id, label: p.label || '', boosts: p.boosts_value })),
    });
  })
);

router.patch(
  '/sellauth',
  asyncHandler(async (req, res) => {
    if (req.body?.webhookSecret !== undefined) {
      const secret = String(req.body.webhookSecret || '').trim();
      if (secret && secret.length < 8) return res.status(400).json({ error: 'Webhook secret looks too short' });
      await setConfig('sellauth_webhook_secret', secret);
    }
    if (req.body?.defaultBoosts !== undefined) {
      const n = Number(req.body.defaultBoosts || 0);
      if (!Number.isInteger(n) || n < 0 || n > 1000) return res.status(400).json({ error: 'Default boosts must be a whole number' });
      await setConfig('sellauth_default_boosts', String(n));
    }
    if (req.body?.linkField !== undefined) {
      const f = String(req.body.linkField || '').trim().slice(0, 60);
      await setConfig('sellauth_link_field', f || 'Server Link');
    }
    res.json({ message: 'SellAuth settings saved' });
  })
);

router.post(
  '/sellauth/products',
  asyncHandler(async (req, res) => {
    const sellauthId = String(req.body?.sellauthId || '').trim();
    const boosts = Number(req.body?.boosts);
    const label = String(req.body?.label || '').trim().slice(0, 80);
    if (!sellauthId) return res.status(400).json({ error: 'SellAuth product or variant ID is required' });
    if (!Number.isInteger(boosts) || boosts < 1) return res.status(400).json({ error: 'Boosts must be a positive whole number' });
    const { data: found } = await supabase.from('sellauth_products').select('id').is('owner_id', null).eq('sellauth_id', sellauthId).maybeSingle();
    const { error } = found
      ? await supabase.from('sellauth_products').update({ label, boosts_value: boosts }).eq('id', found.id)
      : await supabase.from('sellauth_products').insert({ sellauth_id: sellauthId, label, boosts_value: boosts });
    if (error) throw error;
    res.status(201).json({ message: 'Product linked' });
  })
);

router.delete(
  '/sellauth/products/:id',
  asyncHandler(async (req, res) => {
    const { error } = await supabase.from('sellauth_products').delete().eq('id', req.params.id).is('owner_id', null);
    if (error) throw error;
    res.json({ message: 'Link removed' });
  })
);

router.get(
  '/sellauth/deliveries',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('sellauth_deliveries')
      .select('id, invoice_id, product_id, product_name, boosts_value, key_code, server_link, status, error, payload, created_at')
      .is('owner_id', null)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({
      deliveries: (data || []).map((d) => ({
        id: d.id,
        invoiceId: d.invoice_id,
        productId: d.product_id,
        productName: d.product_name,
        boosts: d.boosts_value,
        key: d.key_code,
        serverLink: d.server_link || '',
        status: d.status,
        error: d.error,
        // Only failures expose the raw payload: it shows which fields SellAuth
        // actually sent, so a product can be linked correctly.
        payload: d.status === 'error' ? d.payload : undefined,
        createdAt: d.created_at,
      })),
    });
  })
);

// ---------------------------------------------------------------------------
// Resellers — customers with their own stock, keys, redeem page and API
// ---------------------------------------------------------------------------

// PATCH /api/admin/users/:id/reseller — switch reseller access on/off and/or
// set the price charged per delivered boost (USD, 0 = free).
router.patch(
  '/users/:id/reseller',
  asyncHandler(async (req, res) => {
    const { data: user } = await supabase.from('users').select('id, username, role').eq('id', req.params.id).maybeSingle();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be resellers' });

    const patch = {};
    if (req.body?.enabled !== undefined) patch.reseller = Boolean(req.body.enabled);
    if (req.body?.boostPrice !== undefined) {
      const price = Number(req.body.boostPrice);
      if (!Number.isFinite(price) || price < 0 || price > 100) return res.status(400).json({ error: 'Price per boost must be between 0 and 100' });
      patch.boost_price = Number(price.toFixed(4));
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    const { error } = await supabase.from('users').update(patch).eq('id', user.id);
    if (error) throw error;
    res.json({ message: patch.reseller === undefined ? `Price saved for ${user.username}` : `${user.username} is ${patch.reseller ? 'now a reseller' : 'no longer a reseller'}` });
  })
);

// GET /api/admin/resellers — every reseller with their stock / keys / volume.
router.get(
  '/resellers',
  asyncHandler(async (req, res) => {
    const baseCols = 'id, username, balance, boost_price, api_key_prefix, redeem_slug, redeem_title, created_at';
    const withSellauth = `${baseCols}, sellauth_ref, sellauth_secret`;
    let rs, error;
    ({ data: rs, error } = await supabase
      .from('users')
      .select(withSellauth)
      .eq('reseller', true)
      .order('created_at', { ascending: true }));
    // Older DBs may lack sellauth_* columns until migration_resellers / migration_sellauth_users runs.
    if (error && /sellauth_ref|sellauth_secret|schema cache|does not exist/i.test(error.message || '')) {
      ({ data: rs, error } = await supabase
        .from('users')
        .select(baseCols)
        .eq('reseller', true)
        .order('created_at', { ascending: true }));
    }
    if (error) throw error;
    const ids = (rs || []).map((r) => r.id);
    if (!ids.length) return res.json({ resellers: [] });

    const [stock, keys, jobs, sales] = await Promise.all([
      supabase.from('stock_tokens').select('owner_id, status').in('owner_id', ids).limit(100000),
      supabase.from('redeem_keys').select('owner_id, boosts_value, redeemed_at').in('owner_id', ids).limit(100000),
      supabase.from('jobs').select('owner_id, boosts_delivered, status, mode').in('owner_id', ids).limit(100000),
      supabase.from('sellauth_deliveries').select('owner_id').in('owner_id', ids).eq('status', 'delivered').limit(100000),
    ]);
    const by = (rows) => (rows || []).reduce((m, r) => { (m[r.owner_id] ||= []).push(r); return m; }, {});
    const S = by(stock.data), K = by(keys.data), J = by(jobs.data), D = by(sales.data);

    res.json({
      resellers: rs.map((r) => ({
        id: r.id,
        username: r.username,
        balance: Number(r.balance || 0),
        boostPrice: Number(r.boost_price || 0),
        apiKey: r.api_key_prefix || '',
        page: r.redeem_slug || '',
        stockUnused: (S[r.id] || []).filter((t) => t.status === 'unused').length,
        stockUsed: (S[r.id] || []).filter((t) => t.status === 'used').length,
        keysUnused: (K[r.id] || []).filter((k) => !k.redeemed_at).length,
        keysTotal: (K[r.id] || []).length,
        boosts: (J[r.id] || []).filter((j) => j.mode !== 'join').reduce((n, j) => n + (j.boosts_delivered || 0), 0),
        joins: (J[r.id] || []).filter((j) => j.mode === 'join').reduce((n, j) => n + (j.boosts_delivered || 0), 0),
        orders: (J[r.id] || []).filter((j) => j.mode !== 'join').length,
        sales: (D[r.id] || []).length,
        sellauth: Boolean(r.sellauth_ref && r.sellauth_secret),
        createdAt: r.created_at,
      })),
    });
  })
);

// POST /api/admin/resellers/:id/revoke-api — kill a reseller's API key.
router.post(
  '/resellers/:id/revoke-api',
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('users')
      .update({ api_key_hash: null, api_key_prefix: null, api_key_created_at: null })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'API key revoked' });
  })
);

module.exports = router;
