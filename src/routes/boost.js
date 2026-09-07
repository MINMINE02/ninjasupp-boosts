'use strict';

const express = require('express');
const supabase = require('../config/supabase');
const {
  asyncHandler,
  parseInviteCode,
  parseTokenList,
  normalizeKeyCode,
} = require('../utils/helpers');
const Salta7Service = require('../services/salta7');
const { getSettings } = require('../services/settings');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const salta7 = new Salta7Service();

// How many boosts a single token provides — for the key/redeem flow (tokens
// drawn from the stock pool) and for the BYOT max-boosts check. Always a
// positive integer.
const BOOSTS_PER_TOKEN = Math.max(1, Math.round(Number(process.env.BOOSTS_PER_TOKEN) || 2));
// Extra stock tokens reserved (on top of the strict minimum) so that if one
// of them fails, Salta7 can automatically fall back to a spare within the
// same job instead of the whole redeem failing. Default 0 — exactly one token
// is used per BOOSTS_PER_TOKEN boosts (e.g. 14 boosts -> 7 tokens). Set
// SPARE_STOCK_TOKENS > 0 in the env to opt back into failover spares.
const SPARE_STOCK_TOKENS = Math.max(0, Math.floor(Number(process.env.SPARE_STOCK_TOKENS) || 0));
// When a job falls short, we automatically pull FRESH replacement tokens from
// the stock pool for whatever boosts are still owed and start a new job with
// them — so a dead/failing token is swapped for a working one instead of the
// redeem failing. This is how many replacement rounds we allow before giving
// up (each round can draw more fresh stock). Raise MAX_BOOST_RETRIES in the
// env for even more persistence.
const MAX_BOOST_RETRIES = Number(process.env.MAX_BOOST_RETRIES || 10);
// If a job goes this long without delivering a single additional boost, it's
// considered stalled and treated as failed instead of polling forever. Real
// token automation (login, captcha solve, join, boost) can legitimately take
// well over a minute per account, especially with several tokens in one job
// — a short timeout here finalizes (and the frontend stops polling) a job
// that is actually still working upstream, so its real, later delivery is
// simply never seen and gets shown to the user as "failed" even though the
// boost genuinely landed on Discord. Err on the side of patience.
const STALL_TIMEOUT_MS = Number(process.env.BOOST_STALL_TIMEOUT_MS || 240_000);

// ---------------------------------------------------------------------------
// PUBLIC: POST /api/boost/redeem
// Anonymous key-based boosting: enter a key + invite and we start a job for
// the boost amount the key is worth, drawing the required tokens from the
// admin-managed stock pool.
// ---------------------------------------------------------------------------
router.post(
  '/redeem',
  asyncHandler(async (req, res) => {
    const invite = parseInviteCode(req.body?.invite);
    const code = normalizeKeyCode(req.body?.key);

    if (!invite) {
      return res.status(400).json({ error: 'A valid invite link or code is required' });
    }
    if (!code) {
      return res.status(400).json({ error: 'Invalid or expired key' });
    }

    const { data: key } = await supabase
      .from('redeem_keys')
      .select('*')
      .eq('code', code)
      .maybeSingle();

    if (!key) {
      return res.status(404).json({ error: 'Invalid or expired key' });
    }
    if (key.redeemed_at) {
      return res.status(409).json({ error: 'This key has already been used' });
    }

    // Claim the key atomically (guard against double-redeem).
    const { data: claimed } = await supabase
      .from('redeem_keys')
      .update({ redeemed_at: new Date().toISOString(), redeemed_invite: invite })
      .eq('id', key.id)
      .is('redeemed_at', null)
      .select('*')
      .maybeSingle();

    if (!claimed) {
      return res.status(409).json({ error: 'This key has already been used' });
    }

    const releaseKey = () =>
      supabase
        .from('redeem_keys')
        .update({ redeemed_at: null, redeemed_invite: null })
        .eq('id', key.id);

    // The key may already carry a partial delivery from a previous attempt
    // (e.g. the last run only delivered some of the boosts) — only the
    // remaining amount is owed this time, and only that much is deducted.
    const keyTotal = Number(claimed.boosts_value);
    const keyDeliveredBefore = Number(claimed.boosts_delivered) || 0;
    const boosts = keyTotal - keyDeliveredBefore;
    if (boosts <= 0) {
      await releaseKey();
      return res.status(409).json({ error: 'This key has already been fully redeemed' });
    }
    const needed = Math.ceil(boosts / BOOSTS_PER_TOKEN);
    // Try to grab a few spares too — Salta7 receives the whole list in one
    // job and moves on to the next token if one fails, so any spares we get
    // act as an automatic failover pool at no extra cost.
    const wanted = needed + SPARE_STOCK_TOKENS;

    // Reserve the required number of tokens from the stock pool (plus spares
    // if available).
    const { data: available } = await supabase
      .from('stock_tokens')
      .select('id, token')
      .eq('status', 'unused')
      .limit(wanted);

    if (!available || available.length < needed) {
      await releaseKey();
      return res.status(409).json({
        error: `Not enough stock tokens available (need ${needed}, have ${available?.length || 0}).`,
      });
    }

    const ids = available.map((r) => r.id);
    const { data: reserved } = await supabase
      .from('stock_tokens')
      .update({ status: 'used', used_at: new Date().toISOString() })
      .in('id', ids)
      .eq('status', 'unused')
      .select('id, token');

    // A concurrent redeem may have grabbed some of them first.
    if (!reserved || reserved.length < needed) {
      if (reserved && reserved.length) {
        await supabase
          .from('stock_tokens')
          .update({ status: 'unused', used_at: null })
          .in('id', reserved.map((r) => r.id));
      }
      await releaseKey();
      return res.status(409).json({ error: 'Stock tokens were just taken, please try again.' });
    }

    const reservedIds = reserved.map((r) => r.id);
    const tokens = reserved.map((r) => r.token);

    const releaseTokens = () =>
      supabase
        .from('stock_tokens')
        .update({ status: 'unused', used_at: null })
        .in('id', reservedIds);

    // Start the job on Salta7 using the reserved stock tokens.
    let remote;
    try {
      remote = await salta7.createBoostJob(invite, tokens);
    } catch (err) {
      await releaseTokens();
      await releaseKey();
      return res
        .status(err.status && err.status < 500 ? err.status : 502)
        .json({ error: `Could not start the boost: ${err.message}` });
    }

    const salta7JobId = extractJobId(remote);

    const { data: job, error: insertErr } = await supabase
      .from('jobs')
      .insert({
        user_id: null,
        key_id: key.id,
        salta7_job_id: salta7JobId ? String(salta7JobId) : null,
        invite,
        mode: 'key',
        boosts_requested: boosts,
        tokens_used: reserved.length, // tokens we sent to Salta7
        status: 'running',
      })
      .select('*')
      .single();

    if (insertErr) throw insertErr;

    // Link the used tokens to the job for auditing.
    await supabase
      .from('stock_tokens')
      .update({ used_by_job: job.id })
      .in('id', reservedIds);

    res.status(201).json({
      message: `Key redeemed! Boosting ${boosts} with ${invite}`,
      job: {
        id: job.id,
        invite,
        mode: 'key',
        boostsRequested: boosts,
        tokensUsed: reserved.length,
        status: job.status,
      },
      keyTotal,
      keyDelivered: keyDeliveredBefore,
    });
  })
);

// PUBLIC: GET /api/boost/redeem/status/:id — poll an anonymous key job.
router.get(
  '/redeem/status/:id',
  asyncHandler(async (req, res) => {
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .eq('mode', 'key')
      .maybeSingle();

    if (!job) return res.status(404).json({ error: 'Job not found' });
    const synced = await syncJob(job);

    // The key's own running total (across every attempt, not just this
    // job) — that's what "boosts done / boosts owed" should reflect.
    let keyTotal = null;
    let keyDelivered = null;
    if (synced.key_id) {
      const { data: keyRow } = await supabase
        .from('redeem_keys')
        .select('boosts_value, boosts_delivered')
        .eq('id', synced.key_id)
        .maybeSingle();
      if (keyRow) {
        keyTotal = Number(keyRow.boosts_value);
        const priorPlusLive = synced.status === 'running'
          ? Number(keyRow.boosts_delivered || 0) + Number(synced.boosts_delivered || 0)
          : Number(keyRow.boosts_delivered || 0);
        keyDelivered = Math.min(keyTotal, priorPlusLive);
      }
    }

    res.json({ job: mapJob(synced), keyTotal, keyDelivered });
  })
);

// PUBLIC: GET /api/boost/redeem/items/:id — per-token results of a key job.
router.get(
  '/redeem/items/:id',
  asyncHandler(async (req, res) => {
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .eq('mode', 'key')
      .maybeSingle();

    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ items: await fetchItems(job) });
  })
);

// PUBLIC: GET /api/boost/invite-info?code=... — look up a Discord invite so
// the UI can preview the server (name, icon, members, online, boosts).
router.get(
  '/invite-info',
  asyncHandler(async (req, res) => {
    const code = parseInviteCode(req.query?.code || req.query?.invite);
    if (!code) return res.status(400).json({ error: 'Invalid invite' });

    let data;
    try {
      const r = await fetch(
        `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`,
        { headers: { 'User-Agent': 'Ninja Boost (https://ninja-boost, 1.0)' } }
      );
      if (!r.ok) return res.status(404).json({ error: 'Invite not found or expired' });
      data = await r.json();
    } catch {
      return res.status(502).json({ error: 'Could not reach Discord' });
    }

    const g = data.guild || {};
    res.json({
      id: g.id || null,
      name: g.name || 'Unknown server',
      icon: g.id && g.icon
        ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${g.icon.startsWith('a_') ? 'gif' : 'png'}?size=128`
        : null,
      memberCount: data.approximate_member_count ?? null,
      onlineCount: data.approximate_presence_count ?? null,
      boostCount: g.premium_subscription_count ?? null,
    });
  })
);

// ---------------------------------------------------------------------------
// BYOT (login required) — the user boosts with their OWN tokens and pays,
// from their wallet, only for captchas that actually get solved.
// ---------------------------------------------------------------------------

// POST /api/boost/quote — live BYOT price estimate.
router.post(
  '/quote',
  requireAuth,
  asyncHandler(async (req, res) => {
    const tokens = parseTokenList(req.body?.tokens);
    const boosts = Number(req.body?.boosts || 0);

    const settings = await getSettings();
    const quote = await salta7.getBYOTQuote(tokens, boosts, {
      captchaCost: settings.captcha_cost,
    });
    res.json(quote);
  })
);

// POST /api/boost/start — start a BYOT boost job with the user's own tokens.
router.post(
  '/start',
  requireAuth,
  asyncHandler(async (req, res) => {
    const invite = parseInviteCode(req.body?.invite);
    const boosts = Number(req.body?.boosts || 0);
    const autoRetry = Boolean(req.body?.autoRetry);

    if (!invite) {
      return res.status(400).json({ error: 'A valid invite link or code is required' });
    }
    if (!Number.isInteger(boosts) || boosts < 1 || boosts > 40) {
      return res.status(400).json({ error: 'Boosts must be between 1 and 40' });
    }

    const tokens = parseTokenList(req.body?.tokens);
    if (tokens.length === 0) {
      return res.status(400).json({ error: 'Provide at least one token' });
    }
    const maxBoosts = tokens.length * BOOSTS_PER_TOKEN;
    if (boosts > maxBoosts) {
      return res.status(400).json({
        error: `Your ${tokens.length} tokens can provide at most ${maxBoosts} boosts`,
      });
    }

    // BYOT is paid from the user's wallet, but only for captchas that are
    // actually solved. We don't debit anything up front — the wallet must
    // merely be able to cover the worst-case ("potential") cost, which is one
    // captcha per submitted token, so the job can never overrun the balance.
    const settings = await getSettings();
    const potentialCost = Number((tokens.length * Number(settings.captcha_cost || 0)).toFixed(4));

    const { data: walletRow } = await supabase
      .from('users')
      .select('balance')
      .eq('id', req.user.id)
      .single();
    const balance = Number(walletRow?.balance ?? 0);
    if (balance < potentialCost) {
      return res.status(402).json({
        error: `Insufficient balance. This boost can cost up to $${fmtMoney(potentialCost)} but your wallet has $${fmtMoney(balance)}. Please deposit first.`,
        required: potentialCost,
        balance,
      });
    }

    let remote;
    try {
      remote = await salta7.createBoostJob(invite, tokens);
    } catch (err) {
      return res
        .status(err.status && err.status < 500 ? err.status : 502)
        .json({ error: `Salta7 could not start the job: ${err.message}` });
    }

    const salta7JobId = extractJobId(remote);

    const { data: job, error: insertErr } = await supabase
      .from('jobs')
      .insert({
        user_id: req.user.id,
        salta7_job_id: salta7JobId ? String(salta7JobId) : null,
        invite,
        mode: 'byot',
        boosts_requested: boosts,
        tokens_used: tokens.length,
        auto_retry: autoRetry,
        status: 'running',
      })
      .select('*')
      .single();

    if (insertErr) throw insertErr;

    // No debit here — the wallet is charged incrementally in syncJob() as
    // captchas are actually solved on Salta7.
    res.status(201).json({
      job: {
        id: job.id,
        salta7JobId,
        invite,
        mode: 'byot',
        boostsRequested: boosts,
        status: job.status,
        autoRetry,
      },
      potentialCost,
      balance,
    });
  })
);

// GET /api/boost/status/:id — poll a BYOT job (auth, owner or admin).
router.get(
  '/status/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your job' });
    }

    const synced = await syncJob(job);
    const { data: walletRow } = await supabase
      .from('users')
      .select('balance')
      .eq('id', req.user.id)
      .maybeSingle();
    res.json({ job: mapJob(synced), balance: Number(walletRow?.balance ?? 0) });
  })
);

// GET /api/boost/items/:id — delivered results for a BYOT job.
router.get(
  '/items/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your job' });
    }
    res.json({ items: await fetchItems(job) });
  })
);

// GET /api/boost/history — the current user's recent BYOT jobs.
router.get(
  '/history',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: jobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(20);

    const synced = await Promise.all(
      (jobs || []).map((j) => (j.status === 'running' ? syncJob(j).catch(() => j) : j))
    );

    res.json({ jobs: synced.map(mapJob) });
  })
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resends only the given tokens as a fresh Salta7 job. `cachedItems` is the
// full merged (masked) per-token picture known so far -- it's persisted onto
// the job row so a token that already joined/boosted under the PREVIOUS
// Salta7 job doesn't vanish from status/items just because we're no longer
// polling that job id. On success the job row is repointed at the new
// Salta7 job and the retry counter is bumped; the caller should return the
// updated row as-is (still 'running') and let the next poll pick up the
// retry's progress. Returns null if the retry couldn't be started, in which
// case the caller should fall through to finalizing as failed.
async function retryJobTokens(job, retryCount, tokens, cachedItems) {
  if (!tokens || tokens.length === 0) return null;

  let remote;
  try {
    remote = await salta7.createBoostJob(job.invite, tokens);
  } catch {
    return null;
  }
  const salta7JobId = extractJobId(remote);
  if (!salta7JobId) return null;

  const { data: updated } = await supabase
    .from('jobs')
    .update({
      salta7_job_id: String(salta7JobId),
      retry_count: retryCount + 1,
      last_progress_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      cached_items: Array.isArray(cachedItems) ? cachedItems : [],
    })
    .eq('id', job.id)
    .select('*')
    .single();

  return updated || null;
}

// Atomically reserves up to `count` fresh UNUSED stock tokens and links them
// to `jobId` (so they're audited against the job and never handed out twice).
// Returns the bare token strings actually reserved — fewer than `count`, or an
// empty array, when the pool is running low. This is what lets a failed token
// be replaced by a working one on retry so a redeem keeps delivering.
async function reserveFreshStock(count, jobId) {
  if (!Number.isFinite(count) || count <= 0) return [];

  const { data: available } = await supabase
    .from('stock_tokens')
    .select('id, token')
    .eq('status', 'unused')
    .limit(count);
  if (!available || available.length === 0) return [];

  const ids = available.map((r) => r.id);
  const { data: reserved } = await supabase
    .from('stock_tokens')
    .update({ status: 'used', used_at: new Date().toISOString(), used_by_job: jobId })
    .in('id', ids)
    .eq('status', 'unused') // guard against a concurrent redeem grabbing them first
    .select('token');

  return (reserved || []).map((r) => r.token).filter(Boolean);
}

// Fetches per-token results for the CURRENTLY ACTIVE Salta7 job only (no
// history from earlier retries). `keepRaw` also carries the unmasked token
// so callers can match it back to stock_tokens — it must NEVER be sent to
// the client as-is; strip it first (see stripRaw / fetchItems below).
async function fetchLiveItems(job, { keepRaw = false } = {}) {
  if (!job.salta7_job_id) return [];
  // Jobs are always created with mode:'byot' on Salta7 (see salta7.createBoostJob),
  // so the BYOT items endpoint is the right one; fall back to the stock endpoint
  // in case the upstream shape differs.
  let raw;
  try {
    raw = await salta7.getBYOTItems(job.salta7_job_id);
  } catch {
    try {
      raw = await salta7.getJobItems(job.salta7_job_id);
    } catch {
      return [];
    }
  }
  return normalizeItems(raw, { keepRaw });
}

function stripRaw(items) {
  return items.map(({ rawToken, ...rest }) => rest);
}

// Public-facing per-token results: the live view from the currently active
// Salta7 job, merged with whatever was cached onto the job row from earlier
// retries. A retry only resends tokens that haven't joined yet (see
// syncJob), so a token that already joined/boosted under a PREVIOUS Salta7
// job would otherwise silently disappear the moment we switch job ids —
// this merge is what keeps it visible ("boosted but shown as failed/gone").
async function fetchItems(job) {
  const cached = Array.isArray(job.cached_items) ? job.cached_items : [];
  const live = stripRaw(await fetchLiveItems(job));
  if (cached.length === 0) return live;
  const liveTokens = new Set(live.map((i) => i.token));
  return [...live, ...cached.filter((i) => !liveTokens.has(i.token))];
}

function normalizeItems(raw, { keepRaw = false } = {}) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.accounts)) list = raw.accounts; // GET /task/byot/items
  else if (raw && Array.isArray(raw.tokens)) list = raw.tokens; // GET /task/items (stock)
  else if (raw && Array.isArray(raw.items)) list = raw.items;
  else if (raw && Array.isArray(raw.results)) list = raw.results;
  else if (raw && Array.isArray(raw.data)) list = raw.data;

  return list.map((it) => {
    if (it == null) return { token: '', ok: null, boosts: 0, captcha: false, reason: '' };
    if (typeof it === 'string') {
      const entry = { token: maskToken(it), ok: null, boosts: 0, captcha: false, reason: '' };
      if (keepRaw) entry.rawToken = it;
      return entry;
    }
    const rawToken =
      it.token || it.item_data || it.credential || it.id || it.address || it.username || it.email || '';
    const boosts = Number(it.boosts ?? it.transferred ?? 0) || 0;
    const captcha = Boolean(it.cap_hit);
    const reason = it.reason || it.error || it.message || it.detail || '';
    // A token that reports a positive boost count clearly worked, even if its
    // status string is one we don't recognise — trust the number over the
    // label so a real delivery is never mislabelled as pending/failed.
    let ok = itemOk(it);
    if (ok === null && boosts > 0) ok = true;
    const entry = {
      token: maskToken(String(rawToken)),
      ok,
      boosts,
      captcha,
      reason: String(reason),
    };
    if (keepRaw) entry.rawToken = String(rawToken);
    return entry;
  });
}

// Maps a Salta7 per-account result to worked (true) / failed (false) /
// still-pending (null). The documented `status` values are "joined",
// "already_in", "failed", "pending" and "not_used"; a few extra synonyms
// are accepted defensively in case the shape drifts.
function itemOk(it) {
  const s = String(it.status || it.state || it.result || '').toLowerCase();
  if (['joined', 'already_in', 'success', 'ok', 'done', 'boosted', 'delivered', 'completed', 'valid', 'working'].includes(s)) {
    return true;
  }
  if (['failed', 'fail', 'error', 'invalid', 'dead', 'locked'].includes(s)) {
    return false;
  }
  if (['pending', 'not_used'].includes(s)) return null;
  for (const key of ['success', 'ok', 'boosted', 'valid', 'delivered']) {
    if (typeof it[key] === 'boolean') return it[key];
  }
  return null; // unknown
}

// Formats a USD amount without forcing it to exactly 2 decimals — a captcha
// charge is $0.015, and toFixed(2) would silently round that to $0.02.
function fmtMoney(n) {
  n = Number(n) || 0;
  let s = n.toFixed(4);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  const decimals = s.includes('.') ? s.split('.')[1].length : 0;
  return decimals < 2 ? n.toFixed(2) : s;
}

// Reveals roughly the first half of a token (rest replaced with an
// ellipsis) — enough to spot-check without exposing the whole credential.
function maskToken(token) {
  if (!token) return '';
  const revealLen = Math.max(6, Math.ceil(token.length / 2));
  if (token.length <= revealLen) return token;
  return `${token.slice(0, revealLen)}…`;
}

// Picks the first defined, numeric value from a list.
function firstNum(values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

// Extracts the task id from whatever shape /task/create returns.
function extractJobId(remote) {
  if (!remote) return null;
  if (typeof remote === 'string' || typeof remote === 'number') return String(remote);
  const direct =
    remote.id ?? remote.jobId ?? remote.job_id ?? remote.taskId ?? remote.taskID ??
    remote.task_id ?? remote.uuid ?? remote.identifier;
  if (direct != null && typeof direct !== 'object') return String(direct);
  if (remote.data) {
    const d = extractJobId(remote.data);
    if (d) return d;
  }
  if (remote.task) {
    const t = extractJobId(remote.task);
    if (t) return t;
  }
  return null;
}

// Fetches the latest status + per-token results from Salta7 and writes the
// derived progress back to the job row.
//
// Real Salta7 fields (per the API docs):
//   GET /task/status  -> { status: "running"|"completed"|"partial"|"failed",
//                          boosts_requested, boosts_delivered, tokens_used,
//                          failed_count, cost_charged, duration_seconds, ... }
//   GET /task/byot/items -> { accounts: [{ token, status, boosts,
//                          transferred, cap_hit, ... }] }
// "completed"/"partial"/"failed" are all terminal (the job is done); only
// "running" means it's still going. boosts_delivered — or, failing that,
// the sum of each account's own `boosts` field — is the real progress
// count, not a guess based on how many tokens merely "worked".
async function syncJob(job) {
  if (!job.salta7_job_id) return job;

  const [status, liveItemsRaw] = await Promise.all([
    salta7.getJobStatus(job.salta7_job_id).catch(() => null),
    fetchLiveItems(job, { keepRaw: true }).catch(() => []),
  ]);

  // If both upstream calls failed, keep what we have.
  if (!status && liveItemsRaw.length === 0) return job;

  const liveItems = stripRaw(liveItemsRaw);
  const cachedItems = Array.isArray(job.cached_items) ? job.cached_items : [];
  const hasCache = cachedItems.length > 0;
  const liveTokens = new Set(liveItems.map((i) => i.token));
  // The full picture across EVERY attempt so far. A retry resends only the
  // tokens that haven't joined yet (see below), so a token that already
  // joined/boosted under a PREVIOUS (now-abandoned) Salta7 job would
  // otherwise silently vanish the moment we start polling a new job id —
  // this merge is what keeps a real, already-delivered boost visible.
  const mergedItems = [...liveItems, ...cachedItems.filter((i) => !liveTokens.has(i.token))];

  const okCount = mergedItems.filter((i) => i.ok === true).length;
  const failCount = mergedItems.filter((i) => i.ok === false).length;

  // Whether THIS round (the currently active Salta7 job) is done — scoped to
  // liveItems only, never the cumulative merged view, or a retry job
  // covering just the leftover tokens would never look "fully processed"
  // (it would keep comparing against the ORIGINAL, larger token count).
  const liveProcessed = liveItems.filter((i) => i.ok !== null).length;
  const itemsDelivered = mergedItems.reduce((sum, i) => sum + (Number(i.boosts) || 0), 0);

  // Delivered boosts — measured, never assumed. Trust the REAL count Salta7
  // reports: its own total (boosts_delivered) or the sum of the per-token
  // boost numbers. Only when there is NO numeric signal at all do we fall back
  // to assuming each joined token delivered its full share. That estimate is a
  // last resort and must NEVER override a real, lower count — otherwise a key
  // gets marked "successful" before its boosts have actually landed, and the
  // top-up loop stops early (exactly the 14-on-the-key-but-only-10-land bug).
  const joinedEstimate = okCount * BOOSTS_PER_TOKEN;
  const statusDelivered = firstNum([
    status && status.boosts_delivered, status && status.delivered, status && status.boostsDelivered,
    status && status.boosts,
    status && status.completed, status && status.done, status && status.success,
  ]);
  // Once we've retried, the active job's own status count covers only the
  // leftover batch and can't be the grand total, so lean on the cumulative
  // per-token sum instead.
  const numericDelivered = Math.max(
    hasCache ? 0 : (statusDelivered != null ? statusDelivered : 0),
    itemsDelivered
  );
  const haveNumericSignal =
    (statusDelivered != null && statusDelivered > 0) || itemsDelivered > 0;
  let delivered = haveNumericSignal ? numericDelivered : joinedEstimate;

  // Terminal upstream state. A job Salta7 reports as fully completed is trusted
  // as full delivery ONLY when we have no numeric count that contradicts it —
  // if Salta7 says "completed" but reported just 10 of 14 boosts, we keep the
  // real 10 and top up the rest rather than claiming success early.
  const raw = String((status && (status.status || status.state || status.phase)) || '').toLowerCase();
  const successTerminal = ['completed', 'complete', 'done', 'success', 'finished', 'ok'].includes(raw);
  const failTerminal = ['partial', 'failed', 'fail', 'error', 'cancelled', 'canceled'].includes(raw);
  if (successTerminal && !haveNumericSignal && job.boosts_requested > 0) {
    delivered = Math.max(delivered, job.boosts_requested);
  }
  if (job.boosts_requested) delivered = Math.min(delivered, job.boosts_requested);
  // Delivered boosts are permanent — never let the running count regress below
  // what we already recorded (e.g. a replacement job whose per-token numbers
  // came back empty this poll).
  const priorDelivered = Number(job.boosts_delivered) || 0;
  delivered = Math.max(delivered, priorDelivered);

  // Whether this sync actually moved the needle — used to reset the stall clock
  // and to decide the job's state.
  const progressed = delivered > priorDelivered;

  let state = 'running';
  const fullyDelivered = job.boosts_requested > 0 && delivered >= job.boosts_requested;
  const allProcessed = liveItems.length > 0 && liveProcessed >= liveItems.length;

  // No new boosts delivered in a while -> the job has stalled (e.g. Salta7
  // got stuck applying the boost) and shouldn't be polled forever.
  const lastProgressAt = new Date(job.last_progress_at || job.created_at).getTime();
  const stalled = !progressed && Date.now() - lastProgressAt >= STALL_TIMEOUT_MS;

  if (fullyDelivered) {
    // The full amount was delivered -> success, regardless of what else the
    // upstream job status says.
    state = 'completed';
  } else if (failTerminal || allProcessed || stalled) {
    // The upstream failed/fell short, every token was processed short of the
    // goal, or it stalled -> failed (and the key is unlocked for the rest).
    state = 'failed';
  }

  if (process.env.DEBUG_BOOST === 'true') {
    console.log('[boost.sync]', {
      job: job.id, salta7: job.salta7_job_id, raw,
      requested: job.boosts_requested, okCount, failCount,
      statusDelivered, itemsDelivered, joinedEstimate, haveNumericSignal, delivered, state,
    });
  }

  // Falling short doesn't necessarily mean the tokens are bad — Salta7 can
  // fail to actually apply the boost (ad/proxy hiccup on their side) even
  // though the account joined fine and the token is still valid. Before
  // giving up, automatically resend only the tokens that have NOT already
  // joined. Resending an already-joined token can't fix a boost that failed
  // to apply server-side (the account is already a member, so a new job just
  // rejoins/no-ops it) — it only wastes another captcha solve, and it's
  // exactly what made a real, already-delivered boost start showing as
  // failed the moment we switched to tracking the new job. Only while the
  // job is still 'running' in the DB — once it's been finalized (key already
  // deducted/unlocked) we must not silently retry
  // again behind that decision's back.
  if (state === 'failed' && job.status === 'running' && job.mode === 'key' && job.key_id) {
    const retryCount = Number(job.retry_count) || 0;
    if (retryCount < MAX_BOOST_RETRIES) {
      // How many boosts are still owed, and how many fresh tokens that needs.
      const owed = Math.max(0, Number(job.boosts_requested || 0) - delivered);
      const need = Math.ceil(owed / BOOSTS_PER_TOKEN);
      if (need > 0) {
        // Pull brand-new UNUSED tokens from the pool to replace the ones that
        // didn't work, so the redeem keeps delivering instead of failing.
        const freshTokens = await reserveFreshStock(need, job.id);
        if (freshTokens.length > 0) {
          // Keep only the tokens that actually worked in the running picture —
          // the failed ones are being replaced, so drop them from the list.
          const keepItems = mergedItems.filter((i) => i.ok === true);
          const retried = await retryJobTokens(job, retryCount, freshTokens, keepItems);
          if (retried) return retried;
        }
        // Pool is empty (no replacements available) — fall through and finalize
        // with whatever actually landed instead of spinning forever.
      }
    }
  }

  // A key is only fully "spent" once every boost it's worth has been
  // delivered. On finalization (first time we see this job as done), credit
  // whatever this run actually delivered onto the key's running total; if
  // that isn't the full amount, only that much is deducted and the key is
  // unlocked again so the remainder can still be redeemed later.
  const justFinalized = (state === 'completed' || state === 'failed') && job.status === 'running';
  if (justFinalized && job.mode === 'key' && job.key_id) {
    const { data: keyRow } = await supabase
      .from('redeem_keys')
      .select('code, boosts_value, boosts_delivered')
      .eq('id', job.key_id)
      .maybeSingle();

    if (keyRow) {
      const cumulativeDelivered = Math.min(
        Number(keyRow.boosts_value),
        (Number(keyRow.boosts_delivered) || 0) + delivered
      );
      const patch = { boosts_delivered: cumulativeDelivered };
      if (state === 'failed') {
        // Still owes boosts — unlock so it can be redeemed again for the rest.
        patch.redeemed_at = null;
        patch.redeemed_invite = null;
      }
      await supabase.from('redeem_keys').update(patch).eq('id', job.key_id);
    }
  }

  // BYOT billing: charge the user's wallet for newly-solved captchas only
  // (never below zero, only ever growing). This is the only place BYOT money
  // leaves the wallet — it tracks the Salta7 API-key spend one captcha at a
  // time, at OUR configured price, not whatever Salta7's own accounting says.
  // key/redeem jobs never touch a wallet.
  let chargedCost = Number(job.cost) || 0;
  if (job.mode === 'byot' && job.user_id) {
    const settings = await getSettings();
    const captchaCost = Number(settings.captcha_cost) || 0;
    const processedCount = okCount + failCount; // a captcha is attempted whether the join then succeeds or fails
    const actualCost = Math.max(chargedCost, Number((processedCount * captchaCost).toFixed(4)));
    const delta = Number((actualCost - chargedCost).toFixed(4));
    if (delta > 0) {
      const { data: u } = await supabase
        .from('users')
        .select('balance')
        .eq('id', job.user_id)
        .single();
      const bal = Number(u?.balance ?? 0);
      const debit = Math.min(delta, bal);
      if (debit > 0) {
        // Keep full precision — rounding to cents would eat fractions of a
        // cent on every $0.015 captcha charge.
        await supabase
          .from('users')
          .update({ balance: Number((bal - debit).toFixed(4)) })
          .eq('id', job.user_id);
        chargedCost = Number((chargedCost + debit).toFixed(4));
      }
    }
  }

  const patch = {
    boosts_delivered: Number(delivered) || 0,
    cost: chargedCost,
    status: state,
    updated_at: new Date().toISOString(),
    // Keep the job row's cached picture current even outside a retry, so
    // /items always has the latest merged view without needing an extra
    // upstream call.
    cached_items: mergedItems,
  };
  // Only bump the stall clock when boosts actually moved forward this cycle
  // — otherwise leave it where it was so a genuine stall keeps accumulating.
  if (progressed) patch.last_progress_at = new Date().toISOString();

  const { data: updated } = await supabase
    .from('jobs')
    .update(patch)
    .eq('id', job.id)
    .select('*')
    .single();

  return updated || job;
}

function mapJob(job) {
  return {
    id: job.id,
    salta7JobId: job.salta7_job_id,
    invite: job.invite,
    mode: job.mode,
    boostsRequested: job.boosts_requested,
    boostsDelivered: job.boosts_delivered,
    tokensUsed: job.tokens_used,
    status: job.status,
    cost: Number(job.cost),
    autoRetry: job.auto_retry,
    retryCount: job.retry_count || 0,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

module.exports = router;
