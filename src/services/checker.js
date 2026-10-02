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
const { maskToken, fail } = require('./reseller');

const salta7 = new Salta7Service();
const MAX_CHECK = 1000;                 // Salta7 limit per check
const STALE_MS = 30 * 60 * 1000;        // a "running" check older than this is ignored
const PURGEABLE = ['invalid', 'locked', 'error'];
const RANK = { invalid: 0, locked: 1, error: 2, valid: 3 };
const PROGRESS_ONLY = 1_000_000;        // `after` cursor past every result -> status + counts only

const scope = (q, ownerId) => (ownerId ? q.eq('owner_id', ownerId) : q.is('owner_id', null));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function view(row, extra = {}) {
  return {
    id: row.id,
    status: row.status,
    total: row.total,
    counts: row.counts || {},
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

async function startCheck(ownerId) {
  const { data: running } = await scope(
    supabase.from('token_checks').select('id, created_at').eq('status', 'running'), ownerId,
  ).limit(5);
  if ((running || []).some((r) => Date.now() - new Date(r.created_at).getTime() < STALE_MS)) {
    throw fail(409, 'A check is already running — wait for it to finish');
  }

  const { data: tokens, error } = await scope(
    supabase.from('stock_tokens').select('token').eq('status', 'unused'), ownerId,
  ).order('created_at', { ascending: true }).limit(MAX_CHECK);
  if (error) throw error;
  if (!tokens || !tokens.length) throw fail(400, 'No unused tokens to check');

  let remote;
  try {
    remote = await salta7.createCheckJob(tokens.map((t) => t.token));
  } catch (err) {
    throw fail(err.status && err.status < 500 ? err.status : 502, `Salta7 could not start the check: ${err.message}`);
  }
  const jobId = remote?.job_id || remote?.id;
  if (!jobId) throw fail(502, 'Salta7 did not return a job id');

  const { data: row, error: insErr } = await supabase
    .from('token_checks')
    .insert({ owner_id: ownerId || null, salta7_job_id: String(jobId), total: num(remote.total) || tokens.length, status: 'running' })
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
  let d;
  try {
    d = await salta7.getCheckItems(row.salta7_job_id, PROGRESS_ONLY);
  } catch (err) {
    if (err.status === 404 || age > STALE_MS) {
      const { data } = await supabase.from('token_checks')
        .update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', row.id).select('*').single();
      return view(data || row, { checked: 0 });
    }
    return view(row, { checked: 0 });          // transient (rate limit…): keep polling
  }

  const raw = String(d?.status || 'running').toLowerCase();
  const counts = d?.counts && typeof d.counts === 'object' ? d.counts : {};
  const checked = num(d?.checked);
  if (raw === 'running') return view(row, { checked, counts });

  const { data } = await supabase.from('token_checks')
    .update({ status: raw === 'completed' ? 'completed' : 'failed', counts, finished_at: new Date().toISOString() })
    .eq('id', row.id).select('*').single();
  return view(data || row, { checked });
}

async function fetchAll(row) {
  const d = await salta7.getCheckItems(row.salta7_job_id, 0);
  return Array.isArray(d?.results) ? d.results : [];
}

/** Finished check: summary + the first rows (problems first). Tokens are masked. */
async function results(ownerId, id, limit = 300) {
  const row = await getRow(ownerId, id);
  if (row.status === 'running') throw fail(409, 'The check is still running');
  if (row.status !== 'completed') throw fail(409, 'This check did not complete — run it again');
  const list = await fetchAll(row);

  const summary = { valid: 0, locked: 0, invalid: 0, error: 0, nitro: 0, freeSlots: 0 };
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

  return { check: view(row), summary, total: rows.length, rows: rows.slice(0, limit) };
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
    .map((r) => String(r.item_data));

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

module.exports = { MAX_CHECK, startCheck, latest, pollCheck, results, purge };
