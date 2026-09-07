'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { requireAuth, requireAdmin, signToken } = require('../middleware/auth');
const { asyncHandler, generateKeyCode, parseCredentialList, extractToken } = require('../utils/helpers');
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

// POST /api/admin/unlock — verify the admin dashboard password (second
// factor). Already gated behind requireAuth+requireAdmin above; rate-limited
// too so it can't be brute-forced even with a valid admin login.
const unlockLimiter = rateLimit({ windowMs: 60_000, max: 10 });
router.post('/unlock', unlockLimiter, (req, res) => {
  const password = String(req.body?.password || '');
  if (password === ADMIN_PANEL_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ error: 'Incorrect admin password' });
});

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
    res.json({
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
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    res.json({ message: 'All stock tokens deleted' });
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
      rows.push({ code, boosts_value: boosts });
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
      .select('code, boosts_value, redeemed_at, redeemed_invite, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    res.json({
      keys: (data || []).map((k) => ({
        code: k.code,
        boosts: k.boosts_value,
        redeemed: Boolean(k.redeemed_at),
        redeemedAt: k.redeemed_at,
        redeemedInvite: k.redeemed_invite,
        createdAt: k.created_at,
      })),
    });
  })
);

// DELETE /api/admin/keys — delete ALL keys.
router.delete(
  '/keys',
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('redeem_keys')
      .delete()
      .neq('code', '');
    if (error) throw error;
    res.json({ message: 'All keys deleted' });
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
      .select('id, username, role, balance, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    res.json({
      users: (data || []).map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        balance: Number(u.balance || 0),
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

module.exports = router;
