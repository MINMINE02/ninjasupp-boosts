'use strict';

/* =========================================================================
 * Job driver — keeps DIRECT SellAuth boosts moving.
 *
 * A normal key redeem is followed by the customer's page, which polls the job
 * status every few seconds; that polling is what retries failed tokens,
 * finalises the job and bills a reseller. A direct SellAuth delivery has no
 * customer watching, so the server does the polling instead:
 *
 *  - on a long-running host (VPS, Railway, Render…) a timer runs it every 20 s;
 *  - on serverless (Vercel) there are no timers: hit  GET /api/cron/sync  every
 *    minute with an external pinger (see docs/SELLAUTH_DIRECT.md);
 *  - the admin Jobs / SellAuth pages also run it when opened.
 *
 * Only jobs started by a direct delivery are driven (their key has source
 * 'sellauth-direct'): customer-watched jobs are left to their own page, so a
 * job is never driven by two pollers at once.
 * ========================================================================= */

const supabase = require('../config/supabase');

const DIRECT_SOURCE = 'sellauth-direct';
let busy = false;
let timer = null;

async function syncDirectJobs(limit = 40) {
  if (busy) return { skipped: true, synced: 0, running: 0 };
  busy = true;
  try {
    const { syncJob } = require('../routes/boost'); // lazy: boost.js is a big module
    const { data, error } = await supabase
      .from('jobs')
      .select('*, redeem_keys!inner(source)')
      .eq('redeem_keys.source', DIRECT_SOURCE)
      .eq('status', 'running')
      .not('salta7_job_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) return { error: error.message, synced: 0, running: 0 };
    let synced = 0;
    for (const row of data || []) {
      const { redeem_keys: _k, ...job } = row;
      try { await syncJob(job); synced += 1; } catch { /* next round retries */ }
    }
    return { synced, running: (data || []).length };
  } finally {
    busy = false;
  }
}

function start(intervalMs = 20000) {
  if (timer) return;
  timer = setInterval(() => { syncDirectJobs().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { syncDirectJobs, start, DIRECT_SOURCE };
