'use strict';

/* =========================================================================
 * Custom domains for premium accounts' redeem pages  (boost.theirshop.com)
 *
 * Flow:  1. the account enters a domain            -> saved with a random token
 *        2. they add a TXT record proving they own it   (_ninja-verify.<domain>)
 *        3. "Check" -> the TXT is read from DNS -> domain marked VERIFIED
 *        4. they point the domain at us (CNAME / A) -> it serves their page
 *
 * Why the TXT proof matters: without it anybody could "claim" the main site's own
 * domain and have it show their page. A domain only ever serves a page once its
 * owner has proven control of its DNS. Claims on the site's own hosts are refused.
 *
 * Optional hosting automation: with VERCEL_API_TOKEN + VERCEL_PROJECT_ID
 * (+ VERCEL_TEAM_ID) a verified domain is attached to the project automatically
 * (certificate included). Without them the admin attaches it by hand.
 * Accounts never see the name of the hosting provider: DNS target is configurable
 * (CUSTOM_DOMAIN_TARGET, e.g. an alias on your own domain).
 * ========================================================================= */

const dns = require('dns');
const crypto = require('crypto');
const supabase = require('../config/supabase');

const TXT_LABEL = '_ninja-verify';
const CACHE_MS = 30_000;
const hostCache = new Map(); // host -> { at, value }

const cfg = () => ({
  target: String(process.env.CUSTOM_DOMAIN_TARGET || 'cname.vercel-dns.com').toLowerCase().replace(/\.$/, ''),
  ip: String(process.env.CUSTOM_DOMAIN_IP || '76.76.21.21'),
  vercelToken: process.env.VERCEL_API_TOKEN || '',
  vercelProject: process.env.VERCEL_PROJECT_ID || '',
  vercelTeam: process.env.VERCEL_TEAM_ID || '',
});

/* ------------------------------ validation -------------------------------- */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BAD_SUFFIX = ['.vercel.app', '.now.sh', '.local', '.localhost', '.internal', '.onion', '.invalid', '.example'];

// "https://Boost.Shop.com/path" -> "boost.shop.com" (or '' when it can't be a public domain)
function normalize(input) {
  let d = String(input == null ? '' : input).trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (!d || d.length > 253) return '';
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return '';
  const tld = labels[labels.length - 1];
  if (!(/^[a-z]{2,24}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld))) return '';   // also rejects IP addresses
  if (BAD_SUFFIX.some((s) => d.endsWith(s))) return '';
  return d;
}

// The site's own hosts: never assignable, never treated as a custom domain.
function primaryHosts() {
  const set = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const add = (v) => {
    if (!v) return;
    String(v).split(',').forEach((x) => {
      const h = String(x).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
      if (h) set.add(h);
    });
  };
  add(process.env.PUBLIC_URL); add(process.env.VERCEL_URL); add(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  add(process.env.VERCEL_BRANCH_URL); add(process.env.PRIMARY_DOMAINS);
  return set;
}
const hostOf = (req) => String((req.headers && req.headers.host) || '').toLowerCase().replace(/:\d+$/, '');
const isPrimary = (host) => {
  if (!host) return true;
  if (host.endsWith('.vercel.app')) return true;
  const p = primaryHosts();
  return p.has(host) || p.has(host.replace(/^www\./, '')) || p.has(`www.${host}`);
};

function err(status, message) { const e = new Error(message); e.status = status; return e; }

/* ------------------------------- DNS checks ------------------------------- */
async function txtProof(domain, token) {
  try {
    const recs = await dns.promises.resolveTxt(`${TXT_LABEL}.${domain}`);
    return recs.some((chunks) => chunks.join('').trim() === `ninja-verify=${token}`);
  } catch { return false; }
}

// Does the domain end up at our servers? (a CNAME chain to the target, or the same IPs)
async function pointsHere(domain) {
  const { target, ip } = cfg();
  try {
    const c = await dns.promises.resolveCname(domain);
    if (c.some((x) => String(x).toLowerCase().replace(/\.$/, '') === target)) return true;
  } catch { /* no CNAME (apex) */ }
  let mine = [];
  try { mine = await dns.promises.resolve4(domain); } catch { return false; }
  if (mine.includes(ip)) return true;
  try {
    const theirs = await dns.promises.resolve4(target);
    return mine.some((a) => theirs.includes(a));
  } catch { return false; }
}

/* ------------------- optional: attach to the hosting project -------------- */
async function hosting(method, path, body) {
  const c = cfg();
  const q = c.vercelTeam ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(c.vercelTeam)}` : '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`https://api.vercel.com${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${c.vercelToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = {};
    try { json = await r.json(); } catch { /* empty */ }
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: { message: e.name === 'AbortError' ? 'timeout' : e.message } } };
  } finally { clearTimeout(t); }
}
const hostingOn = () => { const c = cfg(); return Boolean(c.vercelToken && c.vercelProject); };

async function attach(domain) {
  if (!hostingOn()) return { configured: false };
  const p = cfg().vercelProject;
  const r = await hosting('POST', `/v10/projects/${encodeURIComponent(p)}/domains`, { name: domain });
  const code = r.json && r.json.error && r.json.error.code;
  if (r.ok || code === 'domain_already_exists') return { configured: true, added: true };
  return { configured: true, added: false, error: (r.json && r.json.error && r.json.error.message) || `status ${r.status}` };
}
async function detach(domain) {
  if (!hostingOn()) return;
  await hosting('DELETE', `/v9/projects/${encodeURIComponent(cfg().vercelProject)}/domains/${encodeURIComponent(domain)}`);
}
async function hostingState(domain) {
  if (!hostingOn()) return { configured: false };
  const r = await hosting('GET', `/v9/projects/${encodeURIComponent(cfg().vercelProject)}/domains/${encodeURIComponent(domain)}`);
  if (!r.ok) return { configured: true, added: false };
  let misconfigured = null;
  const c = await hosting('GET', `/v6/domains/${encodeURIComponent(domain)}/config`);
  if (c.ok) misconfigured = Boolean(c.json && c.json.misconfigured);
  return { configured: true, added: true, verified: r.json.verified !== false, misconfigured };
}

/* ------------------------------ account state ----------------------------- */
const COLS = 'custom_domain, custom_domain_token, custom_domain_verified_at';

// What the account's own dashboard may see. The TXT proof is shown only until it is verified.
async function view(userId) {
  const { data, error } = await supabase.from('users').select(COLS).eq('id', userId).maybeSingle();
  const c = cfg();
  const base = {
    supported: !error, txtLabel: TXT_LABEL, target: c.target, ip: c.ip,
    automatic: hostingOn(),
  };
  if (error || !data || !data.custom_domain) return { ...base, domain: '', status: 'none' };
  const verified = Boolean(data.custom_domain_verified_at);
  return {
    ...base,
    domain: data.custom_domain,
    verified,
    status: verified ? 'verified' : 'pending',
    txtName: `${TXT_LABEL}.${data.custom_domain}`,
    txtValue: verified ? '' : `ninja-verify=${data.custom_domain_token}`,
    apex: data.custom_domain.split('.').length === 2,
  };
}

async function claim(userId, rawDomain, requestHost) {
  const domain = normalize(rawDomain);
  if (!domain) throw err(400, 'Enter a domain like boost.yourshop.com (no https://, no path)');
  if (isPrimary(domain) || domain === requestHost || domain === `www.${requestHost}` || `www.${domain}` === requestHost) {
    throw err(400, 'This domain can not be used');
  }
  const { data: me, error: meErr } = await supabase.from('users').select(`id, reseller, redeem_slug, ${COLS}`).eq('id', userId).maybeSingle();
  if (meErr) {
    if (/custom_domain|schema cache|column/i.test(meErr.message || '')) throw err(500, 'This option is temporarily unavailable. Please contact the administrator.');
    throw meErr;
  }
  if (!me || !me.reseller) throw err(403, 'Premium only');
  if (!me.redeem_slug) throw err(400, 'Choose your page name first (Appearance), then add a domain');

  const { data: taken } = await supabase.from('users').select('id').eq('custom_domain', domain).maybeSingle();
  if (taken && taken.id !== userId) throw err(409, 'This domain is already used by another account');
  if (me.custom_domain === domain) return view(userId); // same one: keep the proof / verification as is

  const token = crypto.randomBytes(16).toString('hex');
  const { error } = await supabase.from('users').update({ custom_domain: domain, custom_domain_token: token, custom_domain_verified_at: null }).eq('id', userId);
  if (error) {
    if (/duplicate|unique/i.test(error.message || '')) throw err(409, 'This domain is already used by another account');
    throw error;
  }
  if (me.custom_domain && me.custom_domain_verified_at) await detach(me.custom_domain);
  hostCache.clear();
  return view(userId);
}

// Reads the DNS: proves ownership (TXT) once, then reports whether the domain points here.
async function verify(userId) {
  const { data, error } = await supabase.from('users').select(`id, reseller, ${COLS}`).eq('id', userId).maybeSingle();
  if (error) throw err(500, 'This option is temporarily unavailable. Please contact the administrator.');
  if (!data || !data.reseller) throw err(403, 'Premium only');
  if (!data.custom_domain) throw err(400, 'Add a domain first');
  const domain = data.custom_domain;

  let verified = Boolean(data.custom_domain_verified_at);
  if (!verified) {
    verified = await txtProof(domain, data.custom_domain_token);
    if (verified) {
      await supabase.from('users').update({ custom_domain_verified_at: new Date().toISOString() }).eq('id', userId);
      hostCache.clear();
    }
  }
  const out = { domain, verified, pointing: false, active: false, hosting: { configured: hostingOn() } };
  if (!verified) return out;

  out.pointing = await pointsHere(domain);
  if (hostingOn()) {
    const a = await attach(domain);
    out.hosting = { ...a, ...(a.added ? await hostingState(domain) : {}) };
    out.active = Boolean(out.pointing && a.added && out.hosting.verified !== false && !out.hosting.misconfigured);
  } else {
    out.active = out.pointing;
  }
  return out;
}

async function remove(userId) {
  const { data } = await supabase.from('users').select(COLS).eq('id', userId).maybeSingle();
  const { error } = await supabase.from('users').update({ custom_domain: null, custom_domain_token: null, custom_domain_verified_at: null }).eq('id', userId);
  if (error) throw error;
  if (data && data.custom_domain && data.custom_domain_verified_at) await detach(data.custom_domain);
  hostCache.clear();
}

/* ------------------------- serving: Host -> account ------------------------ */
// Only VERIFIED domains of active premium accounts that have a page resolve.
async function byHost(host) {
  host = String(host || '').toLowerCase();
  if (!host) return null;
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = null;
  try {
    const { data, error } = await supabase
      .from('users').select('id, reseller, redeem_slug, custom_domain, custom_domain_verified_at')
      .eq('custom_domain', host).maybeSingle();
    if (!error && data && data.reseller && data.redeem_slug && data.custom_domain_verified_at) {
      value = { userId: data.id, slug: data.redeem_slug, domain: data.custom_domain };
    }
  } catch { value = null; }
  if (hostCache.size > 1000) hostCache.clear();
  hostCache.set(host, { at: Date.now(), value });
  return value;
}
const clearCache = () => hostCache.clear();

module.exports = { TXT_LABEL, normalize, isPrimary, hostOf, view, claim, verify, remove, byHost, clearCache, hostingOn, primaryHosts };
