'use strict';

/**
 * Joiner — add members to a Discord server with the reseller's OWN stock
 * tokens (Salta7 tool "join", mode "byot"; join only, no boost).
 *
 *  - Tokens are NOT consumed: an account that joined is still a valid token.
 *  - Billing mirrors BYOT: nothing up front, the wallet only has to cover the
 *    worst case, then each captcha that was really hit is charged at the
 *    platform's captcha price (solver_down / solve_failed are never charged).
 *  - A job lives in `jobs` with mode 'join', user_id NULL and owner_id =
 *    the reseller, so it never shows up in boost history / boost totals.
 */

const supabase = require('../config/supabase');
const Salta7Service = require('./salta7');
const { getSettings } = require('./settings');
const { parseTokenList } = require('../utils/helpers');
const { maskToken, fail, addStock } = require('./reseller');

const salta7 = new Salta7Service();
const MAX_JOIN = 100;                       // Salta7 limit per join job
const STALL_MS = Number(process.env.JOIN_STALL_TIMEOUT_MS || 600_000); // 10 min without progress
const DONE = new Set(['joined', 'already_in']);
const NOT_CHARGED = new Set(['solver_down', 'solve_failed']);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function normalizeItems(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
  return list.map((a) => {
    const status = String(a?.status || 'pending').toLowerCase();
    return {
      token: maskToken(String(a?.token || '')),
      status,
      captcha: Boolean(a?.cap_hit),
      billable: Boolean(a?.cap_hit) && !NOT_CHARGED.has(status),
      freeJoin: Boolean(a?.free_join),
    };
  });
}

function mapJoin(job, { items = false } = {}) {
  const cached = Array.isArray(job.cached_items) ? job.cached_items : [];
  return {
    id: job.id,
    invite: job.invite,
    status: job.status,
    requested: job.boosts_requested,
    joined: job.boosts_delivered,
    tokens: job.tokens_used,
    cost: Number(job.cost || 0),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    ...(items ? { items: cached } : {}),
  };
}

/**
 * opts.tokens : pasted tokens (string with one per line, or an array) — used
 *               for this join only, no need to put them in Files first.
 * opts.count  : how many accounts of the reseller's stock to use (when no tokens pasted).
 * opts.save   : also add the pasted tokens to the reseller's stock afterwards.
 */
async function startJoin(reseller, invite, opts = {}) {
  const pasted = opts.tokens != null && opts.tokens !== '' ? parseTokenList(opts.tokens) : null;
  if (pasted && !pasted.length) throw fail(400, 'No token found in what you pasted');
  const count = pasted ? pasted.length : Number(opts.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_JOIN) {
    throw fail(400, pasted ? `Paste at most ${MAX_JOIN} tokens per join (you pasted ${count})` : `Accounts must be a whole number between 1 and ${MAX_JOIN}`);
  }

  // One join at a time per reseller: keeps the wallet check honest and stops
  // the same tokens being sent to two jobs at once.
  const { data: running } = await supabase
    .from('jobs').select('id').eq('owner_id', reseller.id).eq('mode', 'join').eq('status', 'running').limit(1);
  if (running && running.length) throw fail(409, 'A join is already running — wait for it to finish');

  let tokens;
  if (pasted) {
    tokens = pasted.map((token) => ({ token }));
  } else {
    const { data, error } = await supabase
      .from('stock_tokens').select('token')
      .eq('owner_id', reseller.id).eq('status', 'unused')
      .order('created_at', { ascending: true }).limit(count);
    if (error) throw error;
    if (!data || data.length < count) {
      throw fail(409, `Not enough tokens in your stock (need ${count}, you have ${data ? data.length : 0}).`);
    }
    tokens = data;
  }

  const settings = await getSettings();
  const captchaCost = num(settings.captcha_cost);
  const potential = Number((count * captchaCost).toFixed(4));
  const { data: me } = await supabase.from('users').select('balance').eq('id', reseller.id).maybeSingle();
  const balance = num(me?.balance);
  if (balance < potential) {
    throw fail(402, `Insufficient balance: this join can cost up to $${potential} (one captcha per account) but your wallet has $${balance}.`);
  }

  let remote;
  try {
    remote = await salta7.createJoinJob(invite, tokens.map((t) => t.token));
  } catch (err) {
    throw fail(err.status && err.status < 500 ? err.status : 502, `Salta7 could not start the join: ${err.message}`);
  }
  const jobId = remote?.job_id || remote?.id;
  if (!jobId) throw fail(502, 'Salta7 did not return a job id');

  const { data: job, error: insErr } = await supabase
    .from('jobs')
    .insert({
      user_id: null, owner_id: reseller.id, salta7_job_id: String(jobId),
      invite, mode: 'join', boosts_requested: count, tokens_used: count, status: 'running',
    })
    .select('*').single();
  if (insErr) throw insErr;

  // Optional: keep the pasted accounts in the reseller's stock (best effort —
  // the join is already running, so a failure here must not fail the request).
  let saved = null;
  if (pasted && opts.save) {
    try { saved = await addStock(reseller.id, opts.tokens); } catch { saved = null; }
  }
  return { job: mapJoin(job), potentialCost: potential, balance, source: pasted ? 'pasted' : 'stock', saved };
}

/** Pulls the latest state from Salta7, bills new captchas once, saves progress. */
async function syncJoin(job) {
  if (job.status !== 'running' || !job.salta7_job_id) return job;

  const [status, rawItems] = await Promise.all([
    salta7.getJobStatus(job.salta7_job_id).catch(() => null),
    salta7.getBYOTItems(job.salta7_job_id).catch(() => null),
  ]);
  if (!status && !rawItems) return job;

  const items = normalizeItems(rawItems);
  const joinedItems = items.filter((i) => DONE.has(i.status)).length;
  const requested = num(job.boosts_requested);
  const prior = num(job.boosts_delivered);
  const reported = status ? num(status.boosts_delivered) : 0;
  const joined = Math.min(requested || Infinity, Math.max(prior, reported, joinedItems));

  const raw = String(status?.status || '').toLowerCase();
  let state = 'running';
  if (raw === 'completed') state = 'completed';
  else if (raw === 'partial') state = 'partial';
  else if (['failed', 'error', 'cancelled', 'canceled'].includes(raw)) state = 'failed';
  else if (joined >= requested && requested > 0) state = 'completed';

  const progressed = joined > prior;
  const last = new Date(job.last_progress_at || job.created_at).getTime();
  if (state === 'running' && !progressed && Date.now() - last >= STALL_MS) state = 'failed';

  // ---- billing: only for captchas not charged yet, claimed atomically ----
  let charged = num(job.cost);
  const settings = await getSettings();
  const price = num(settings.captcha_cost);
  const wanted = Number((items.filter((i) => i.billable).length * price).toFixed(4));
  const delta = Number((wanted - charged).toFixed(4));
  if (delta > 0 && job.owner_id) {
    const { data: u } = await supabase.from('users').select('balance').eq('id', job.owner_id).maybeSingle();
    const bal = num(u?.balance);
    const debit = Math.min(delta, bal);
    if (debit > 0) {
      const next = Number((charged + debit).toFixed(4));
      // Only the poller whose cost matches wins the claim -> never double-charged.
      const { data: claim } = await supabase
        .from('jobs').update({ cost: next }).eq('id', job.id).eq('cost', job.cost).select('id');
      if (claim && claim.length) {
        await supabase.from('users').update({ balance: Number((bal - debit).toFixed(4)) }).eq('id', job.owner_id);
        charged = next;
      } else {
        const { data: fresh } = await supabase.from('jobs').select('cost').eq('id', job.id).maybeSingle();
        charged = num(fresh?.cost);
      }
    }
  }

  const patch = {
    boosts_delivered: joined, status: state, cost: charged,
    cached_items: items, updated_at: new Date().toISOString(),
  };
  if (progressed) patch.last_progress_at = new Date().toISOString();
  const { data: updated } = await supabase.from('jobs').update(patch).eq('id', job.id).select('*').single();
  return updated || job;
}

module.exports = { MAX_JOIN, startJoin, syncJoin, mapJoin };
