'use strict';

/* =========================================================================
 * Job driver — keeps boosts moving when nobody is watching them.
 *
 * A normal key redeem is followed by the customer's page, which polls the job
 * status every few seconds; that polling is what retries failed tokens,
 * finalises the job, bills a reseller and starts the profile (humanizer) job.
 * If the customer closes the page, the server takes over:
 *
 *  - DIRECT SellAuth boosts have no customer page at all -> always driven;
 *  - any other running job is driven once it has gone quiet for STALE_MS
 *    (every sync bumps `updated_at`, so a job that a page is polling is
 *    never touched here — two pollers on one job is avoided);
 *  - running profile (humanize) jobs are refreshed;
 *  - the Salta7 balance is read (at most every 5 min) for the low-balance alert.
 *
 * On a long-running host (VPS, Railway, Render…) a timer runs it every 20 s;
 * on serverless (Vercel) there are no timers: hit  GET /api/cron/sync  every
 * minute with an external pinger (see docs/SELLAUTH_DIRECT.md); the admin
 * Jobs / SellAuth pages also run it when opened.
 * ========================================================================= */

const supabase = require('../config/supabase');

const DIRECT_SOURCE = 'sellauth-direct';
const STALE_MS = 45_000;
const BALANCE_EVERY_MS = 5 * 60_000;
let busy = false;
let timer = null;
let lastBalanceAt = 0;

async function syncDirectJobs(limit = 40) {
  if (busy) return { skipped: true, synced: 0, running: 0 };
  busy = true;
  try {
    const { syncJob } = require('../routes/boost'); // lazy: boost.js is a big module

    // 1) direct SellAuth jobs (no customer page)
    const direct = await supabase
      .from('jobs')
      .select('*, redeem_keys!inner(source)')
      .eq('redeem_keys.source', DIRECT_SOURCE)
      .eq('status', 'running')
      .not('salta7_job_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (direct.error) return { error: direct.error.message, synced: 0, running: 0 };

    // 2) every other running job whose page went quiet
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const quiet = await supabase
      .from('jobs')
      .select('*')
      .eq('status', 'running')
      .not('salta7_job_id', 'is', null)
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(limit);

    const seen = new Set();
    const rows = [];
    for (const row of direct.data || []) {
      const { redeem_keys: _k, ...job } = row;
      seen.add(job.id); rows.push(job);
    }
    for (const job of (quiet.data || [])) {
      if (!seen.has(job.id)) { seen.add(job.id); rows.push(job); }
    }

    let synced = 0;
    for (const job of rows.slice(0, limit)) {
      try { await syncJob(job); synced += 1; } catch { /* next round retries */ }
    }

    // premium accounts whose paid period ended (shop): switch the flag off
    try { await require('./shop').expirePremiums(); } catch { /* ignore */ }
    // Litecoin payments nobody is watching any more (page closed, no webhook): pick them up here
    try { await require('./shop').syncPendingDeposits(); } catch { /* ignore */ }

    // profile jobs + Salta7 balance: best-effort, never break the sync
    let humanize = 0;
    try { humanize = await require('./humanizer').syncRunning(); } catch { /* ignore */ }
    const balance = await watchBalance();

    return { synced, running: rows.length, humanize, balance };
  } finally {
    busy = false;
  }
}

// Reads the Salta7 balance (throttled) and fires the low-balance alert.
async function watchBalance() {
  if (Date.now() - lastBalanceAt < BALANCE_EVERY_MS) return null;
  lastBalanceAt = Date.now();
  try {
    const Salta7Service = require('./salta7');
    const amount = await new Salta7Service().getBalanceAmount();
    if (amount !== null) await require('./alerts').checkBalance(amount);
    return amount;
  } catch {
    return null;
  }
}

function start(intervalMs = 20000) {
  if (timer) return;
  timer = setInterval(() => { syncDirectJobs().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { syncDirectJobs, syncJobs: syncDirectJobs, start, DIRECT_SOURCE };
