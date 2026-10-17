'use strict';

/* =========================================================================
 * Humanizer — optional account profile (avatar / name / bio) for key redeems.
 *
 * A customer can ask, when redeeming a key, for the accounts that boost their
 * server to get a profile. The request is stored in `job_humanize` when the
 * boost job starts; once that boost job is finished, ONE Salta7 `humanize`
 * job is started for the accounts that actually joined. It is best-effort:
 * a humanize problem never affects the boost, the key or any billing.
 * (Run db/migration_humanize.sql once.)
 * ========================================================================= */

const supabase = require('../config/supabase');
const Salta7Service = require('./salta7');
const { getConfig, setConfig } = require('./config');

const salta7 = new Salta7Service();

const NAME_MAX = 32;                 // Salta7 limits
const BIO_MAX = 190;
const AVATAR_MAX_CHARS = 400_000;    // data: URL length (the page sends a 256x256 JPEG, ~25 KB)
const GIVE_UP_MS = 15 * 60 * 1000;   // a humanize job still "running" after this is closed as failed
const AVATAR_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const len = (str) => Array.from(str).length;
const STILL_RUNNING = ['running', 'pending', 'queued', 'processing', 'in_progress', 'started', 'created', 'waiting'];

/* ------------------- admin settings (Settings -> Account profile) ------------------- */
// enabled : the card on the redeem pages (default on)
// names / bios : the admin's own lists. When a customer picks "Random", each account gets one
//   of these (instead of Salta7's library). Empty list = Salta7's own random library.
const MAX_POOL = 300;
const MAX_GROUPS = 25;               // one Salta7 humanize job per group of accounts
const SETTINGS_TTL_MS = 15_000;
let settingsCache = null;

const toLines = (text, max) => {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const v = raw.replace(CONTROL_RE, ' ').trim();
    if (v && len(v) <= max && !out.includes(v)) out.push(v);
    if (out.length >= MAX_POOL) break;
  }
  return out;
};

async function getSettings() {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const [en, names, bios] = await Promise.all([
    getConfig('humanizer_enabled'), getConfig('humanizer_names'), getConfig('humanizer_bios'),
  ]);
  const value = { enabled: String(en) !== '0', names: toLines(names, NAME_MAX), bios: toLines(bios, BIO_MAX) };
  settingsCache = { at: Date.now(), value };
  return value;
}

// patch: { enabled?: boolean, names?: string (one per line), bios?: string }
async function saveSettings(patch = {}) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (patch.enabled !== undefined) await setConfig('humanizer_enabled', patch.enabled ? '1' : '0');
  for (const [key, max, label] of [['names', NAME_MAX, 'name'], ['bios', BIO_MAX, 'bio']]) {
    if (patch[key] === undefined) continue;
    const raw = String(patch[key] || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const tooLong = raw.find((l) => len(l) > max);
    if (tooLong) bad(`A ${label} can be at most ${max} characters: “${tooLong.slice(0, 40)}…”`);
    await setConfig(`humanizer_${key}`, toLines(patch[key], max).join('\n'));
  }
  settingsCache = null;
  return getSettings();
}

const shuffle = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const chunk = (arr, parts) => { const size = Math.ceil(arr.length / parts); const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

/**
 * Validates the `humanize` object sent by the redeem page.
 * Returns { value } (null when nothing was asked for) or { error }.
 */
function validate(input) {
  if (input === undefined || input === null || input === false) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid profile settings' };

  const out = {};

  const av = input.avatar;
  if (av && typeof av === 'object') {
    if (av.source === 'random') out.avatar = { source: 'random' };
    else if (av.source === 'custom') {
      const v = String(av.value || '');
      if (!AVATAR_RE.test(v) || v.length > AVATAR_MAX_CHARS) {
        return { error: 'The profile picture must be a PNG, JPEG, WebP or GIF image' };
      }
      out.avatar = { source: 'custom', value: v };
    }
  }

  const nm = input.name;
  if (nm && typeof nm === 'object') {
    if (nm.source === 'random') out.name = { source: 'random' };
    else if (nm.source === 'custom') {
      const v = String(nm.value || '').replace(CONTROL_RE, ' ').trim();
      if (v) {
        if (len(v) > NAME_MAX) return { error: `The profile name can be at most ${NAME_MAX} characters` };
        out.name = { source: 'custom', value: v };
      }
    }
  }

  const bio = input.bio;
  if (bio && typeof bio === 'object') {
    if (bio.source === 'random') out.bio = { source: 'random' };
    else if (bio.source === 'custom') {
      const v = String(bio.value || '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
      if (v) {
        if (len(v) > BIO_MAX) return { error: `The profile bio can be at most ${BIO_MAX} characters` };
        out.bio = { source: 'custom', value: v };
      }
    }
  }

  return { value: Object.keys(out).length ? out : null };
}

/** Remembers that this redeem job asked for a profile. Throws if it can't. */
async function attach(jobId, humanize) {
  const { error } = await supabase
    .from('job_humanize')
    .upsert({ job_id: jobId, fields: humanize, status: 'pending' }, { onConflict: 'job_id' });
  if (error) throw new Error(error.message);
}

function jobIdOf(remote) {
  if (!remote || typeof remote !== 'object') return null;
  const id = remote.job_id ?? remote.id ?? (remote.data && (remote.data.job_id ?? remote.data.id));
  return id != null ? String(id) : null;
}

async function setStatus(jobId, patch) {
  await supabase
    .from('job_humanize')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('job_id', jobId);
}

/**
 * Called ONCE, when the boost job is finalized. Starts the Salta7 humanize job
 * for the accounts that joined. `items` is the job's merged per-account
 * picture (masked tokens + ok flag), `maskToken` the same masking function, so
 * the stock tokens used by the job can be matched back to it.
 * Never throws.
 */
async function startForJob(job, items, maskToken, delivered = 0) {
  try {
    // Claim it: only one caller may start the humanize job.
    const { data: claimed, error } = await supabase
      .from('job_humanize')
      .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('job_id', job.id)
      .eq('status', 'pending')
      .select('job_id, fields')
      .maybeSingle();
    if (error || !claimed) return; // no profile asked for (or table not migrated)

    const list = items || [];
    // An account counts as joined when it reported success OR any delivered boost.
    const joined = new Set(list.filter((i) => i.ok === true || Number(i.boosts) > 0).map((i) => i.token));
    const failed = new Set(list.filter((i) => i.ok === false).map((i) => i.token));
    const { data: rows } = await supabase.from('stock_tokens').select('token').eq('used_by_job', job.id);
    const all = (rows || []).map((r) => r.token).filter(Boolean);
    let tokens = all.filter((t) => joined.has(maskToken(t)));

    // The boosts DID land but no account could be matched (the per-account list lagged behind the
    // job total, or the provider shows the token differently): this used to end as "Skipped — no
    // account joined" on a server that was boosted. Use every account of the job except the ones
    // reported as failed; one that did not really join simply fails on its own.
    if (tokens.length === 0 && (Number(delivered) > 0 || joined.size > 0)) {
      tokens = all.filter((t) => !failed.has(maskToken(t)));
    }

    if (tokens.length === 0) {
      await setStatus(job.id, { status: 'skipped', total: 0 });
      return;
    }

    // "Random" name / bio + an admin list -> every group of accounts gets a different pick
    // from the list (one Salta7 job per group). Otherwise a single job for all accounts.
    const cfg = await getSettings();
    const f = claimed.fields || {};
    const poolName = f.name && f.name.source === 'random' && cfg.names.length ? shuffle(cfg.names) : null;
    const poolBio = f.bio && f.bio.source === 'random' && cfg.bios.length ? shuffle(cfg.bios) : null;
    const groups = poolName || poolBio ? chunk(tokens, Math.min(tokens.length, MAX_GROUPS)) : [tokens];

    const ids = [];
    let sent = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const fields = { ...f };
      if (poolName) fields.name = { source: 'custom', value: poolName[i % poolName.length] };
      if (poolBio) fields.bio = { source: 'custom', value: poolBio[i % poolBio.length] };
      try {
        const id = jobIdOf(await salta7.createHumanizeJob(groups[i], fields));
        if (id) { ids.push(id); sent += groups[i].length; }
      } catch (err) {
        console.error('[humanizer] could not start a group:', err.status, err.detail || err.message);
      }
    }
    if (!ids.length) {
      await setStatus(job.id, { status: 'failed', total: tokens.length });
      return;
    }
    // several Salta7 jobs are kept comma-separated in the same column
    await setStatus(job.id, { salta7_job_id: ids.join(','), total: sent });
  } catch (err) {
    console.error('[humanizer] startForJob:', err.message);
  }
}

/**
 * Public state for a redeem job's page: null when no profile was asked for.
 * While the Salta7 humanize job runs, its progress is pulled on each call.
 */
async function getState(jobId) {
  try {
    const { data: row, error } = await supabase
      .from('job_humanize')
      .select('*')
      .eq('job_id', jobId)
      .maybeSingle();
    if (error || !row) return null;

    let cur = row;
    const ids = String(row.salta7_job_id || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (row.status === 'running' && ids.length) {
      const sts = await Promise.all(ids.map((id) => salta7.getJobStatus(id).catch(() => null)));
      if (sts.every(Boolean)) {
        const humanized = sts.reduce((n, st) => n + (Number(st.humanized) || 0), 0);
        const failed = sts.reduce((n, st) => n + (Number(st.humanize_failed) || 0), 0);
        const raws = sts.map((st) => String(st.status || '').toLowerCase());
        let status = 'running';
        // "pending" / "queued"… are still working: only a real end state closes the profile job
        if (raws.every((r) => r !== '' && !STILL_RUNNING.includes(r))) {
          const dead = (r) => r === 'failed' || r === 'error' || r === 'cancelled' || r === 'canceled';
          if (raws.every(dead) || (humanized === 0 && raws.some(dead))) status = 'failed';
          else status = row.total > 0 && humanized < row.total ? 'partial' : 'completed';
        }
        if (status !== row.status || humanized !== row.humanized || failed !== row.failed) {
          cur = { ...row, status, humanized, failed };
          await setStatus(row.job_id, { status, humanized, failed });
        }
      }
    }
    // Never leave a page polling forever on a job that went quiet.
    if (cur.status === 'running' && cur.started_at && Date.now() - new Date(cur.started_at).getTime() > GIVE_UP_MS) {
      cur = { ...cur, status: cur.humanized > 0 ? 'partial' : 'failed' };
      await setStatus(row.job_id, { status: cur.status });
    }

    return {
      status: cur.status,
      total: Number(cur.total) || 0,
      humanized: Number(cur.humanized) || 0,
      failed: Number(cur.failed) || 0,
      fields: Object.keys(row.fields || {}),
    };
  } catch (err) {
    console.error('[humanizer] getState:', err.message);
    return null;
  }
}

/** Refreshes the profile jobs that are still running (called by the job driver). Returns how many. */
async function syncRunning(limit = 20) {
  try {
    const { data } = await supabase.from('job_humanize').select('job_id').eq('status', 'running').limit(limit);
    for (const r of data || []) await getState(r.job_id);
    return (data || []).length;
  } catch { return 0; }
}

module.exports = { validate, attach, startForJob, getState, syncRunning, getSettings, saveSettings };
