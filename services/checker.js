'use strict';

/**
 * Token checker — Salta7 `check` tool (free): validity, lock type, Nitro,
 * free boost slots… for up to 1000 tokens per pass.
 *
 * Works on ONE stock pool: a reseller's own (ownerId) or the platform's
 * (ownerId = null). A check job is stored in `token_checks` with its owner, so
 * nobody can read or purge the results of somebody else's check.
 */

const supabase = require('../config/supabase');
const Salta7Service = require('./salta7');
const { parseCredentialList, extractToken } = require('../utils/helpers');
const { maskToken, fail, addStock } = require('./reseller');

const salta7 = new Salta7Service();
const MAX_CHECK = 1000;                 // Salta7 limit per check
const STALE_MS = 30 * 60 * 1000;        // a "running" check older than this is ignored
const PURGEABLE = ['invalid', 'locked', 'error'];
const RANK = { invalid: 0, locked: 1, error: 2, valid: 3 };
const OK_STATES = ['completed', 'complete', 'done', 'finished', 'success', 'succeeded'];
const FAIL_STATES = ['failed', 'fail', 'error', 'cancelled', 'canceled', 'expired', 'aborted'];
const DEAD_HTTP = [400, 401, 403, 404, 410];   // the job will never answer: stop waiting for it
const PROGRESS_ONLY = 1_000_000;        // `after` cursor past every result -> status + counts only

const scope = (q, ownerId) => (ownerId ? q.eq('owner_id', ownerId) : q.is('owner_id', null));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Whatever shape the provider answers /task/create with: { job_id }, { id }, { task_id }, { data: {…} }…
function extractId(r) {
  if (r == null) return null;
  if (typeof r === 'string' || typeof r === 'number') return String(r);
  const direct = r.job_id ?? r.jobId ?? r.id ?? r.task_id ?? r.taskId ?? r.uuid;
  if (direct != null && typeof direct !== 'object') return String(direct);
  return extractId(r.data) || extractId(r.task) || extractId(r.job) || null;
}

// `counts` also carries our own bookkeeping (skipped tokens, pasted lines): never sent to the page.
const INTERNAL = ['skipped', 'skippedReasons', 'lines'];
function publicCounts(c) {
  const out = {};
  Object.entries(c && typeof c === 'object' ? c : {}).forEach(([k, v]) => { if (!INTERNAL.includes(k)) out[k] = v; });
  return out;
}

function view(row, extra = {}) {
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    counts: publicCounts(row.counts),
    // tokens the provider refused to check (kept inside `counts`, no extra column needed)
    skipped: num(row.counts && row.counts.skipped),
    skippedReasons: Array.isArray(row.counts && row.counts.skippedReasons) ? row.counts.skippedReasons : [],
    createdAt: row.created_at,
    finishedAt: row.finished_at || null,
    ...extra,
  };
}

async function getRow(ownerId, id) {
  const { data } = await scope(supabase.from('token_checks').select('*').eq('id', id), ownerId).maybeSingle();
  if (!data) throw fail(404, 'Check not found');
  return data;
}

/**
 * pasted: optional tokens (string / array) to check instead of the stock.
 * source: which stock to check when nothing is pasted — 'unused' (default) or 'used'
 *         (used tokens that still work can then be put back with reactivate()).
 */
async function startCheck(ownerId, pasted, source) {
  const pool = String(source || 'unused').toLowerCase() === 'used' ? 'used' : 'unused';
  const { data: running } = await scope(
    supabase.from('token_checks').select('id, created_at').eq('status', 'running'), ownerId,
  ).limit(5);
  // A check is only updated when somebody polls it, so one whose page was closed stays
  // "running" in the database even though it finished long ago — and used to block every new
  // check for 30 minutes ("a check is already running"). Settle each one first: only one that
  // is really still running upstream blocks.
  for (const r of running || []) {
    if (Date.now() - new Date(r.created_at).getTime() >= STALE_MS) {
      await supabase.from('token_checks').update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', r.id);
      continue;
    }
    let v = null;
    try { v = await pollCheck(ownerId, r.id); } catch { v = { status: 'running' }; }
    if (v.status === 'running') throw fail(409, 'A check is already running — wait for it to finish');
  }

  let tokens;
  const pastedLines = {};
  if (pasted != null && pasted !== '') {
    const creds = parseCredentialList(pasted);
    if (!creds.length) throw fail(400, 'No token found in what you pasted');
    if (creds.length > MAX_CHECK) throw fail(400, `Paste at most ${MAX_CHECK} tokens per check (you pasted ${creds.length})`);
    tokens = creds.map((c) => ({ token: c.token }));
    // keep the full lines (email:pass:token:2fa) so « Add valid to my stock » does not lose them
    creds.forEach((c) => { if (c.line !== c.token) pastedLines[c.token] = c.line; });
  } else {
    const { data, error } = await scope(
      supabase.from('stock_tokens').select('token, full_line').eq('status', pool), ownerId,
    ).order(pool === 'used' ? 'used_at' : 'created_at', { ascending: true, nullsFirst: true }).limit(MAX_CHECK);
    if (error) throw error;
    if (!data || !data.length) {
      throw fail(400, pool === 'used' ? 'No used tokens to check' : 'No unused tokens to check — paste some, or add stock first');
    }
    // the bare token, re-derived from the saved line (…:token:2fa) when there is one
    tokens = data.map((r) => ({ token: extractToken(r.full_line || r.token) || r.token }));
  }

  let remote;
  try {
    remote = await salta7.createCheckJob(tokens.map((t) => t.token));
  } catch (err) {
    console.error('[checker] could not start a check:', err.status, err.detail || err.message);
    const code = err.status;
    let msg = 'The checker is temporarily unavailable. Please try again in a few minutes.';
    if (code === 429) msg = 'The checker is rate-limited right now. Wait a minute, then try again.';
    else if (code === 402) msg = 'The checker account has no credit left.';
    else if (code === 400 || code === 422) msg = 'The checker refused this list of tokens.';
    // The platform admin gets the provider's own reason; resellers get the neutral message.
    if (!ownerId && err.detail) msg += ` (${code || 'error'}: ${err.detail})`;
    throw fail(502, msg);
  }
  const jobId = extractId(remote);
  if (!jobId) {
    console.error('[checker] check started but no job id in the answer:', JSON.stringify(remote).slice(0, 300));
    throw fail(502, 'The checker is temporarily unavailable. Please try again in a few minutes.'
      + (!ownerId ? ` (no job id in the answer: ${Object.keys(remote && typeof remote === 'object' ? remote : {}).join(', ') || 'empty'})` : ''));
  }

  // The provider answers with a receipt { job_id, total, skipped_* }: tokens it refused to
  // check are counted in skipped_* and NOT in total. Ignoring that made a check of tokens it
  // skipped look like a normal one that then "finished" with 0 results ("0 of 0 checked").
  const receipt = { ...(remote && typeof remote === 'object' ? remote : {}), ...(remote && typeof remote.data === 'object' ? remote.data : {}) };
  const skipped = Object.entries(receipt)
    .filter(([k, v]) => /^skipped/i.test(k) && num(v) > 0)
    .map(([k, v]) => ({ reason: k.replace(/^skipped_?/i, '').replace(/_/g, ' ') || 'other', count: num(v) }));
  const accepted = receipt.total != null && receipt.total !== '' ? num(receipt.total) : null;
  // Fewer accepted than sent: the difference was refused even if the receipt gives no reason.
  const unexplained = accepted != null ? tokens.length - accepted - skipped.reduce((a, x) => a + x.count, 0) : 0;
  if (unexplained > 0) skipped.push({ reason: 'not accepted by the checker', count: unexplained });
  const skippedTotal = skipped.reduce((a, x) => a + x.count, 0);
  if (accepted === 0 && skippedTotal > 0) {
    console.error('[checker] receipt:', JSON.stringify(receipt).slice(0, 300));
    const why = skipped.map((x) => `${x.count} ${x.reason}`).join(', ');
    throw fail(422, `The checker refused all ${tokens.length} token${tokens.length === 1 ? '' : 's'} (${why}) — nothing was checked.`);
  }

  const { data: row, error: insErr } = await supabase
    .from('token_checks')
    .insert({ owner_id: ownerId || null, salta7_job_id: String(jobId), total: accepted > 0 ? accepted : tokens.length, status: 'running', counts: { ...(skippedTotal ? { skipped: skippedTotal, skippedReasons: skipped } : {}), ...(Object.keys(pastedLines).length ? { lines: pastedLines } : {}) } })
    .select('*').single();
  if (insErr) throw insErr;
  return view(row, { checked: 0, submitted: tokens.length });
}

async function latest(ownerId) {
  const { data } = await scope(supabase.from('token_checks').select('*'), ownerId)
    .order('created_at', { ascending: false }).limit(1);
  return data && data[0] ? view(data[0]) : null;
}

/** Progress of a check; records the final counts once it has finished. */
async function pollCheck(ownerId, id) {
  let row = await getRow(ownerId, id);
  if (row.status !== 'running') return view(row, { checked: row.total });

  const age = Date.now() - new Date(row.created_at).getTime();
  const finish = async (status, counts, extra) => {
    const patch = { status, finished_at: new Date().toISOString() };
    // keep what we know about skipped tokens next to the provider's own counts
    if (counts) {
      const mine = {};
      INTERNAL.forEach((k) => { if (row.counts && row.counts[k] !== undefined) mine[k] = row.counts[k]; });
      patch.counts = { ...counts, ...mine };
    }
    const { data } = await supabase.from('token_checks').update(patch).eq('id', row.id).eq('status', 'running').select('*').maybeSingle();
    if (data) return view(data, extra);
    return view(await getRow(ownerId, id), extra); // someone else settled it first
  };

  let d;
  try {
    d = await salta7.getCheckItems(row.salta7_job_id, PROGRESS_ONLY, 8000);
  } catch (err) {
    if (DEAD_HTTP.includes(err.status) || age > STALE_MS) return finish('failed', null, { checked: 0 });
    return view(row, { checked: 0 });          // transient (rate limit, network…): keep polling
  }

  const raw = String(d?.status || d?.state || 'running').toLowerCase();
  const counts = d?.counts && typeof d.counts === 'object' ? d.counts : {};
  // Progress can come as `checked`, `done`/`processed`, or only through the per-status counts.
  const checked = num(d?.checked) || num(d?.done) || num(d?.processed)
    || Object.values(counts).reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);
  const total = num(d?.total) || row.total;
  if (OK_STATES.includes(raw)) {
    // "completed" with nothing checked although tokens were accepted is not a real finish
    // (the provider may report it before it has started): wait a little, then give up.
    const empty = total > 0 && checked === 0 && Object.keys(counts).length === 0;
    if (empty && age < 120_000) return view(row, { checked: 0, counts, total });
    if (empty) return finish('failed', counts, { checked: 0 });
    return finish('completed', counts, { checked: total || checked });
  }
  if (FAIL_STATES.includes(raw)) return finish('failed', counts, { checked });
  // "running", "pending", "queued"… (or a word we don't know): still working. Only give up on
  // a check that has been going far too long. (An unknown word used to count as a failure,
  // so a queued check was reported as "did not finish" the second it started.)
  if (age > STALE_MS) return finish('failed', counts, { checked });
  return view(row, { checked, counts, total });
}

// The list of results inside a /task/items answer, whatever it is called.
const LIST_KEYS = ['results', 'items', 'accounts', 'tokens', 'data', 'rows'];
function pickList(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of LIST_KEYS) if (Array.isArray(d[k])) return d[k];
  const any = Object.values(d).find((v) => Array.isArray(v));
  return any || [];
}
// One result row with the field names we rely on, whatever the provider calls them.
function normItem(r) {
  if (typeof r === 'string') return { item_data: r, status: 'error' };
  const x = r && typeof r === 'object' ? r : {};
  return {
    ...x,
    item_data: x.item_data ?? x.token ?? x.item ?? x.credential ?? x.value ?? '',
    status: x.status ?? x.state ?? x.result ?? undefined,
  };
}

let lastShape = '';
async function fetchAll(row) {
  // Results come page by page (`after` = cursor, `last_id` = next cursor): read them all,
  // otherwise import / purge / reactivate silently only handle the first page.
  const byKey = new Map();
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const d = await salta7.getCheckItems(row.salta7_job_id, after, 20000);
    const list = pickList(d).map(normItem);
    if (page === 0) lastShape = d && typeof d === 'object' ? Object.keys(d).join(', ') : typeof d;
    list.forEach((r) => byKey.set(r.id ?? r.item_data, r));
    const next = Number(d?.last_id);
    if (!list.length || !Number.isFinite(next) || next <= after) break;
    after = next;
  }
  return [...byKey.values()];
}

/** Finished check: summary + the first rows (problems first). Tokens are masked. */
async function results(ownerId, id, limit = 300) {
  const row = await getRow(ownerId, id);
  if (row.status === 'running') throw fail(409, 'The check is still running');
  if (row.status !== 'completed') throw fail(409, 'This check did not complete — run it again');
  const list = await fetchAll(row);
  if (!list.length && row.total > 0) {
    console.error('[checker] no results for check', row.id, 'job', row.salta7_job_id, 'answer keys:', lastShape);
    throw fail(409, 'The checker returned no results for this check — run it again'
      + (!ownerId ? ` (answer fields: ${lastShape || 'none'})` : ''));
  }

  const summary = { valid: 0, locked: 0, invalid: 0, error: 0, nitro: 0, freeSlots: 0, reactivable: 0 };
  const rows = list.map((r) => {
    const status = String(r.status || 'error').toLowerCase();
    if (summary[status] !== undefined) summary[status] += 1;
    if (status === 'valid') {
      if (r.nitro) summary.nitro += 1;
      summary.freeSlots += num(r.boost_free);
    }
    return {
      token: maskToken(String(r.item_data || '')),
      status,
      lockType: r.lock_type || null,
      nitro: Boolean(r.nitro),
      nitroDays: r.nitro_days ?? null,
      boostFree: r.boost_free ?? null,
      ageDays: r.age_days ?? null,
      hasPhone: Boolean(r.has_phone),
    };
  }).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));

  // How many tokens currently marked "used" in this pool still work and could go back to unused.
  summary.reactivable = (await reusableUsed(ownerId, reusableLines(list))).length;

  return { check: view(row), summary, total: rows.length, rows: rows.slice(0, limit) };
}

/**
 * A used token is worth putting back only if it is valid AND the checker reports at
 * least one free boost slot. An unknown (null) or zero `boost_free` is NOT put back:
 * the account may still be carrying its boosts, and selling it again would deliver nothing.
 * Pasted lines ("email:pass:token") are reduced to the bare token, like in stock.
 */
function reusableLines(list) {
  return [...new Set(list
    .filter((r) => r.item_data && String(r.status || '').toLowerCase() === 'valid'
      && num(r.boost_free) > 0)
    .map((r) => extractToken(String(r.item_data)) || String(r.item_data)))];
}

/**
 * Used tokens of this pool among `lines` that are safe to put back: tokens
 * still attached to a boost job in progress are skipped (they would be
 * handed out a second time while their first boost is being delivered).
 * Resolves to [{ id, token }].
 */
async function reusableUsed(ownerId, lines) {
  const found = [];
  for (let i = 0; i < lines.length; i += 50) {
    const { data, error } = await scope(
      supabase.from('stock_tokens').select('id, token, used_by_job').eq('status', 'used').in('token', lines.slice(i, i + 50)), ownerId,
    );
    if (error) throw error;
    found.push(...(data || []));
  }
  const jobIds = [...new Set(found.map((t) => t.used_by_job).filter(Boolean))];
  const busy = new Set();
  for (let i = 0; i < jobIds.length; i += 50) {
    const { data, error } = await supabase.from('jobs').select('id').in('status', ['running', 'pending']).in('id', jobIds.slice(i, i + 50));
    if (error) throw error;
    (data || []).forEach((j) => busy.add(j.id));
  }
  return found.filter((t) => !t.used_by_job || !busy.has(t.used_by_job)).map((t) => ({ id: t.id, token: t.token }));
}

/**
 * Puts back in stock (status 'used' -> 'unused') the used tokens that a finished
 * check found valid with a free boost slot. Only touches THIS pool's used tokens,
 * and never one that belongs to a boost still in progress.
 */
async function reactivate(ownerId, id) {
  const row = await getRow(ownerId, id);
  if (row.status !== 'completed') throw fail(409, 'Only a finished check can be used to reactivate tokens');

  const lines = reusableLines(await fetchAll(row));
  const ready = await reusableUsed(ownerId, lines);
  let reactivated = 0;
  for (let i = 0; i < ready.length; i += 50) {
    const { data, error } = await scope(
      supabase.from('stock_tokens')
        .update({ status: 'unused', used_at: null, used_by_job: null })
        .eq('status', 'used').in('id', ready.slice(i, i + 50).map((t) => t.id)), ownerId,
    ).select('id');
    if (error) throw error;
    reactivated += data ? data.length : 0;
  }
  return { reactivated, flagged: lines.length };
}

/** Deletes the UNUSED tokens of this pool that the check flagged. */
async function purge(ownerId, id, statuses) {
  const wanted = (Array.isArray(statuses) && statuses.length ? statuses : ['invalid'])
    .map((s) => String(s).toLowerCase()).filter((s) => PURGEABLE.includes(s));
  if (!wanted.length) throw fail(400, 'Choose which results to delete (invalid, locked or error)');

  const row = await getRow(ownerId, id);
  if (row.status !== 'completed') throw fail(409, 'Only a finished check can be used to delete tokens');

  const lines = (await fetchAll(row))
    .filter((r) => r.item_data && wanted.includes(String(r.status || '').toLowerCase()))
    .map((r) => extractToken(String(r.item_data)) || String(r.item_data)); // stock holds the bare token

  let deleted = 0;
  for (let i = 0; i < lines.length; i += 50) {
    const { data, error } = await scope(
      supabase.from('stock_tokens').delete().eq('status', 'unused').in('token', lines.slice(i, i + 50)), ownerId,
    ).select('id');
    if (error) throw error;
    deleted += data ? data.length : 0;
  }
  return { deleted, flagged: lines.length };
}

/** Adds the tokens a finished check found valid (or locked) to this pool's stock. */
async function importTokens(ownerId, id, statuses) {
  const wanted = (Array.isArray(statuses) && statuses.length ? statuses : ['valid'])
    .map((s) => String(s).toLowerCase()).filter((s) => ['valid', 'locked'].includes(s));
  if (!wanted.length) throw fail(400, 'Choose valid or locked results to add');

  const row = await getRow(ownerId, id);
  if (row.status !== 'completed') throw fail(409, 'Only a finished check can be imported');

  const saved = (row.counts && row.counts.lines) || {};   // full lines of a pasted check
  const lines = (await fetchAll(row))
    .filter((r) => r.item_data && wanted.includes(String(r.status || '').toLowerCase()))
    .map((r) => saved[String(r.item_data)] || String(r.item_data));

  let added = 0;
  for (let i = 0; i < lines.length; i += 500) {
    const r = await addStock(ownerId || null, lines.slice(i, i + 500));
    added += r.inserted;
  }
  return { added, flagged: lines.length, alreadyInStock: lines.length - added };
}

module.exports = { reusableLines, MAX_CHECK, startCheck, latest, pollCheck, results, purge, importTokens, reactivate };
