'use strict';

/* =========================================================================
 * Ninja Boost — admin panel
 *
 * Plain JS, served as-is (no build step). Every dynamic value is inserted
 * with textContent (never innerHTML), so nothing coming from the database or
 * from a customer can inject markup. No inline handlers: the CSP forbids them.
 *
 * Auth = admin account (Bearer token) + panel password (X-Panel-Token).
 * Both live in sessionStorage, so closing the tab signs you out.
 * ========================================================================= */

// DOM quirk: replaceChildren(null) prints the text "null". Drop empty children
// so optional blocks (`cond ? el(...) : null`) simply don't render.
(function () {
  const orig = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    return orig.apply(this, nodes.flat().filter((n) => n != null && n !== false));
  };
  const origAppend = Element.prototype.append;
  Element.prototype.append = function (...nodes) {
    return origAppend.apply(this, nodes.flat().filter((n) => n != null && n !== false));
  };
})();

const API = '/api';
const S = {
  token: sessionStorage.getItem('nb_admin_token'),
  panel: sessionStorage.getItem('nb_admin_panel'),
  view: 'overview',
  timer: null,
  keys: { list: [], filter: 'all', q: '' },
  navToken: 0,
  param: '',
  jobsFilter: 'all',
};

/* ------------------------------ helpers -------------------------------- */
const $ = (s) => document.querySelector(s);

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const ICONS = {
  checker: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  keys: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/>',
  stock: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  jobs: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  resellers: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  sellauth: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  deposits: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  system: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};
function icon(name) {
  const s = el('span');
  // Static, trusted SVG paths only — never user data.
  s.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return s.firstChild;
}

const num = (n) => Number(n || 0).toLocaleString();
function usd(n) {
  n = Number(n || 0);
  let s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if ((s.split('.')[1] || '').length < 2) s = n.toFixed(2);
  return `$${s}`;
}
function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

let toastTimer;
function toast(msg, type = 'success') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label);
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

const pillFor = (status) =>
  el('span', {
    class: `pill ${({ completed: 'ok', delivered: 'ok', running: 'warn', pending: 'warn', partial: 'warn', valid: 'ok', locked: 'warn', invalid: 'bad', unused: 'ok', failed: 'bad', error: 'bad', used: '', redeemed: '', success: 'ok', exhausted: 'bad', queued: 'warn', suspended: 'bad', active: 'ok' })[status] ?? ''}`,
    text: status,
  });

async function api(path, { method = 'GET', body, quiet = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (S.panel) headers['X-Panel-Token'] = S.panel;
  const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    let msg = data.error || `Request failed (${res.status})`;
    if (/schema cache|does not exist|could not find the/i.test(msg)) {
      msg += ' — the database is missing the new tables/columns. Run db/migration_resellers.sql (or at least db/migration_sellauth_users.sql) in the database SQL editor.';
    }
    const err = new Error(msg);
    err.status = res.status;
    if (!quiet && (res.status === 401 || data.locked)) signOut('Session expired — sign in again.');
    throw err;
  }
  return data;
}

// Wrap an async click handler: disables the button while running, toasts errors.
const act = (fn) => async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
};

const btn = (label, onclick, cls = 'btn-ghost btn-sm') => el('button', { type: 'button', class: `btn ${cls}`, onclick: act(onclick), text: label });
const iconBtn = (name, title, onclick, cls = '') =>
  el('button', { type: 'button', class: `icon-btn ${cls}`, title, 'aria-label': title, onclick: act(onclick) }, icon(name));

function card(title, sub, body, actions) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-h' }, el('div', {}, el('h3', { text: title }), sub && el('p', { text: sub })), actions && el('div', { class: 'actions' }, actions)),
    body);
}
function table(cols, rows, emptyText) {
  if (!rows.length) return el('div', { class: 'empty', text: emptyText });
  // c.hide = a secondary column that is dropped on phones (see mobile.css)
  rows.forEach((tr) => cols.forEach((c, i) => { if (c.hide && tr.children[i]) tr.children[i].classList.add('hide-sm'); }));
  return el('div', { class: 'tbl-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: [c.num ? 'num' : '', c.hide ? 'hide-sm' : ''].join(' ').trim(), text: c.label })))),
    el('tbody', {}, rows)));
}
const kpi = (label, value, small, cls = '') => el('div', { class: `card kpi ${cls}` }, el('span', { text: label }), el('b', { text: value }), el('small', { text: small }));

/* ------------------------------ auth ----------------------------------- */
function showLogin(msg) {
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#l-error').textContent = msg || '';
  $('#l-user').focus();
}
function showShell() {
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
}
function signOut(msg) {
  S.token = S.panel = null;
  sessionStorage.removeItem('nb_admin_token');
  sessionStorage.removeItem('nb_admin_panel');
  clearInterval(S.timer);
  showLogin(typeof msg === 'string' ? msg : '');
}
function setSession(token, panel) {
  S.token = token; S.panel = panel;
  sessionStorage.setItem('nb_admin_token', token);
  sessionStorage.setItem('nb_admin_panel', panel);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = $('#l-submit');
  $('#l-error').textContent = '';
  submit.disabled = true;
  try {
    const login = await api('/auth/login', { method: 'POST', body: { username: $('#l-user').value.trim(), password: $('#l-pass').value }, quiet: true });
    if (login.user?.role !== 'admin') throw new Error('This account is not an administrator');
    S.token = login.token;
    const unlock = await api('/admin/unlock', { method: 'POST', body: { password: $('#l-panel').value }, quiet: true });
    setSession(login.token, unlock.panelToken);
    $('#l-pass').value = $('#l-panel').value = '';
    showShell();
    route();
  } catch (err) {
    S.token = null;
    $('#l-error').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

/* ------------------------------ router --------------------------------- */
const VIEWS = [
  { id: 'overview', title: 'Overview', render: vOverview, live: true },
  { id: 'keys', title: 'Keys', render: vKeys },
  { id: 'stock', title: 'Stock', render: vStock },
  { id: 'checker', title: 'Checker', render: vChecker },
  { id: 'jobs', title: 'Jobs', render: vJobs, live: true },
  { id: 'users', title: 'Users', render: vUsers },
  { id: 'resellers', title: 'Premium', render: vResellers },
  { id: 'deposits', title: 'Deposits', render: vDeposits },
  { id: 'sellauth', title: 'SellAuth', render: vSellauth },
  { id: 'activity', title: 'Activity', render: vActivity },
  { id: 'system', title: 'System', render: vSystem },
  { id: 'settings', title: 'Settings', render: vSettings },
  // Detail pages (opened from a list or the search box — not in the menu).
  { id: 'user', title: 'Account', render: vUser, hidden: true, parent: 'users' },
  { id: 'job', title: 'Job', render: vJob, hidden: true, parent: 'jobs' },
];

function buildNav() {
  const nav = $('#nav');
  const here = (VIEWS.find((v) => v.id === S.view) || {}).parent || S.view;
  nav.replaceChildren(...VIEWS.filter((v) => !v.hidden).map((v) =>
    el('a', { class: 'nav-link', href: `#/${v.id}`, 'aria-current': v.id === here ? 'page' : null }, icon(v.id), el('span', { text: v.title }))));
  $('#logout').replaceChildren(icon('logout'), el('span', { text: 'Sign out' }));
  $('#open-client').replaceChildren(icon('external'), el('span', { text: 'Customer panel' }));
}

/* ------------------------------ mobile drawer --------------------------- */
// On narrow screens the sidebar is an off-canvas drawer (see admin.css). Only
// the toggle + close behaviour lives here — the nav links themselves are
// unchanged, so closing on navigation is just "close after route() runs".
function closeDrawer() {
  $('#side').classList.remove('open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  const scrim = document.querySelector('.scrim');
  if (scrim) scrim.remove();
}
function openDrawer() {
  $('#side').classList.add('open');
  $('#menu-btn').setAttribute('aria-expanded', 'true');
  const scrim = el('div', { class: 'scrim', onclick: closeDrawer });
  document.body.append(scrim);
}
$('#menu-btn').addEventListener('click', () => {
  $('#side').classList.contains('open') ? closeDrawer() : openDrawer();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

let checkTimer = null;

async function route() {
  clearInterval(checkTimer);
  closeDrawer();
  if (!S.token || !S.panel) return showLogin();
  const m = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
  let view = VIEWS.find((v) => v.id === m[1]) || VIEWS[0];
  S.param = m[2] || '';
  if (view.hidden && !S.param) view = VIEWS.find((v) => v.id === view.parent) || VIEWS[0];
  S.view = view.id;
  buildNav();
  $('#view-title').textContent = view.title;
  document.title = `${view.title} · Ninja Boost admin`;
  $('#live').classList.toggle('hidden', !view.live);
  clearInterval(S.timer);
  await paint(view, true);
  if (view.live) S.timer = setInterval(() => paint(view, false), 8000);
}

// Renders into a detached node first, then swaps — no flicker on auto-refresh.
async function paint(view, first) {
  const ticket = ++S.navToken;
  const root = $('#view');
  const next = el('div', { class: 'view-inner', style: 'display:grid;gap:18px' });
  try {
    await view.render(next);
  } catch (err) {
    if (ticket !== S.navToken) return;
    if (first) root.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'form-error', text: err.message })));
    return;
  }
  if (ticket !== S.navToken || S.view !== view.id) return;
  root.replaceChildren(next);
}

window.addEventListener('hashchange', () => { const c = document.querySelector('.content'); if (c) c.scrollTop = 0; });
window.addEventListener('hashchange', route);
$('#refresh').addEventListener('click', () => route());
$('#logout').addEventListener('click', () => signOut());

/* ============================ OVERVIEW ================================== */
function barChart(series, key) {
  const W = 560, H = 170, padB = 22, padT = 8, max = Math.max(1, ...series.map((d) => d[key]));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${key} per day, last 14 days`);
  const ns = (t, a) => { const n = document.createElementNS('http://www.w3.org/2000/svg', t); for (const k in a) n.setAttribute(k, a[k]); return n; };
  [0, 0.5, 1].forEach((f) => {
    const y = padT + (H - padB - padT) * (1 - f);
    svg.append(ns('line', { x1: 0, x2: W, y1: y, y2: y, class: 'grid-l' }));
  });
  const slot = W / series.length, bw = slot * 0.6;
  series.forEach((d, i) => {
    const h = ((H - padB - padT) * d[key]) / max, x = i * slot + (slot - bw) / 2, y = H - padB - h;
    const r = ns('rect', { x, y: d[key] ? y : H - padB - 1, width: bw, height: d[key] ? h : 1, rx: 3, class: 'bar' });
    const t = ns('title', {}); t.textContent = `${d.date}: ${d[key]}`; r.append(t);
    svg.append(r);
    if (i % 2 === 0) { const l = ns('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }); l.textContent = d.date.slice(8); svg.append(l); }
  });
  const top = ns('text', { x: 2, y: padT + 10 }); top.textContent = num(max); svg.append(top);
  return svg;
}

async function vOverview(root) {
  const [st, jobs, ins] = await Promise.all([api('/admin/stats'), api('/admin/jobs?limit=8'), api('/admin/insights', { quiet: true }).catch(() => null)]);
  const need = st.stock.tokensNeeded, have = st.stock.unused;
  const pct = need ? Math.min(100, Math.round((have / need) * 100)) : 100;
  const short = Math.max(0, need - have);
  const running = st.jobs.byStatus.running || 0;

  root.append(
    el('div', { class: 'grid g4' },
      kpi('Unused keys', num(st.keys.unused), `${num(st.keys.total)} generated · ${num(st.keys.redeemed)} redeemed`),
      kpi('Boosts delivered · 24h', num(st.jobs.boosts24h), running ? `${running} job${running > 1 ? 's' : ''} running now` : 'No job running'),
      kpi('Stock tokens', num(have), `${num(st.stock.used)} already used`, short ? 'warn' : ''),
      kpi('SellAuth sales · 24h', num(st.sellauth.last24h), `${num(st.sellauth.delivered)} delivered in total`)),
    el('div', { class: 'grid g-main' },
      card('Boosts delivered', 'Per day, last 14 days', barChart(st.jobs.series, 'boosts')),
      card('Stock coverage', 'Can the stock honour every key you have already sold?', el('div', { class: 'cover' },
        el('div', { class: `cover-bar ${short ? '' : 'ok'}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` })),
        el('div', { class: 'cover-meta' },
          el('span', {}, el('b', { text: num(have) }), ` tokens in stock`),
          el('span', {}, el('b', { text: num(need) }), ` needed (${num(st.keys.owedBoosts)} boosts ÷ ${st.stock.boostsPerToken})`)),
        short
          ? el('div', { class: 'note warn', text: `Short by ${num(short)} token${short > 1 ? 's' : ''}: some unused keys would fail to redeem. Add stock.` })
          : el('div', { class: 'note', text: 'Every unused key can be redeemed with the current stock.' })))),
    card('Premium', 'Customers selling with their own stock and keys', el('div', { class: 'grid g4' },
      kpi('Premium', num(st.resellers.total), 'accounts with premium access'),
      kpi('Their tokens', num(st.resellers.stockUnused), 'unused, across all premium accounts'),
      kpi('Their keys', num(st.resellers.keysUnused), 'unused, across all premium accounts')),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/resellers', text: 'Manage premium' })),
    card('Recent jobs', null, jobsTable(jobs.jobs), el('a', { class: 'btn btn-ghost btn-sm', href: '#/jobs', text: 'All jobs' })));
  if (ins) root.append(...insightBlocks(ins));
}

/* ============================== JOBS ==================================== */
function jobsTable(list) {
  return table(
    [{ label: 'When' }, { label: 'Type' }, { label: 'Owner' }, { label: 'Who' }, { label: 'Server' }, { label: 'Boosts', num: true }, { label: 'Tokens', num: true, hide: true }, { label: 'Status' }, { label: '' }],
    list.map((j) => el('tr', {},
      el('td', { text: ago(j.createdAt) }),
      el('td', {}, el('span', { class: `pill ${j.mode === 'byot' ? '' : 'brand'}`, text: j.mode })),
      el('td', {}, j.owner ? el('span', { class: 'pill brand', text: j.owner }) : el('span', { class: 'muted', text: 'you' })),
      el('td', { class: 'mono', text: j.key || j.user || '—' }),
      el('td', { class: 'mono', text: j.invite || '—' }),
      el('td', { class: 'num', text: `${j.delivered}/${j.requested}${j.mode === 'join' ? ' acc.' : ''}` }),
      el('td', { class: 'num', text: num(j.tokens) }),
      el('td', {}, pillFor(j.status), j.retries ? el('span', { class: 'muted', text: ` ×${j.retries + 1}` }) : null),
      el('td', { class: 'act' }, el('a', { href: `#/job/${j.id}`, text: 'Details' })))),
    'No boost job yet.');
}
async function vJobs(root) {
  const { jobs } = await api('/admin/jobs?limit=300');
  const f = S.jobsFilter;
  const list = jobs.filter((j) => f === 'all' || (f === 'running' ? ['running', 'pending'].includes(j.status) : j.status === f));
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter jobs' },
    [['all', 'All'], ['running', 'Running'], ['completed', 'Completed'], ['failed', 'Failed']].map(([id, label]) =>
      el('button', { type: 'button', 'aria-pressed': String(f === id), text: label, onclick: () => { S.jobsFilter = id; paint(VIEWS.find((v) => v.id === 'jobs'), false); } })));
  root.append(card('Boost jobs', `Latest 300 · ${num(list.length)} shown · refreshes every few seconds`, jobsTable(list), [seg,
    csvBtn('jobs', [
      { label: 'Created', get: (j) => j.createdAt }, { label: 'Type', get: (j) => j.mode }, { label: 'Owner', get: (j) => j.owner || '' },
      { label: 'Who', get: (j) => j.key || j.user || '' }, { label: 'Server', get: (j) => j.invite }, { label: 'Requested', get: (j) => j.requested },
      { label: 'Delivered', get: (j) => j.delivered }, { label: 'Tokens', get: (j) => j.tokens }, { label: 'Cost', get: (j) => j.cost }, { label: 'Status', get: (j) => j.status },
    ], () => list)]));
}

/* ============================== KEYS ==================================== */
async function vKeys(root) {
  const { keys } = await api('/admin/keys');
  S.keys.list = keys;
  const boosts = el('input', { type: 'number', min: 1, value: 14, id: 'g-boosts' });
  const count = el('input', { type: 'number', min: 1, max: 500, value: 10, id: 'g-count' });
  const note = el('input', { type: 'text', maxlength: 120, placeholder: 'Optional — e.g. giveaway, premium account name' });
  const out = el('textarea', { readonly: true, rows: 5 });
  const outBox = el('div', { class: 'hidden', style: 'margin-top:14px;display:grid;gap:8px' }, out,
    el('div', { class: 'actions' }, btn('Copy all', () => copy(out.value, 'Keys copied')), btn('Download .txt', () => download('keys.txt', out.value))));

  const gen = card('Generate keys', 'Each key is worth a fixed number of boosts.', el('div', {},
    el('div', { class: 'row' },
      el('label', {}, 'Boosts per key', boosts), el('label', {}, 'How many', count), el('label', { style: 'flex:2 1 220px' }, 'Note', note),
      el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Generate',
        onclick: act(async () => {
          const d = await api('/admin/keys', { method: 'POST', body: { boostsPerKey: Number(boosts.value), count: Number(count.value), note: note.value } });
          out.value = d.keys.map((k) => k.code).join('\n');
          outBox.classList.remove('hidden');
          toast(d.message);
          await refreshKeys();
        }),
      })),
    outBox));

  const listHost = el('div');
  const summary = el('span', { class: 'muted' });
  const search = el('input', { type: 'search', placeholder: 'Search key, note or server…', style: 'max-width:240px', value: S.keys.q || '', oninput: () => { S.keys.q = search.value.toLowerCase(); draw(); } });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter keys' });
  [['all', 'All'], ['unused', 'Unused'], ['redeemed', 'Redeemed'], ['sellauth', 'SellAuth'], ['resellers', 'Premium']].forEach(([id, label]) =>
    seg.append(el('button', { type: 'button', 'aria-pressed': String(S.keys.filter === id), onclick: () => { S.keys.filter = id; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === label))); draw(); }, text: label })));

  async function refreshKeys() {
    S.keys.list = (await api('/admin/keys')).keys;
    draw();
  }
  function draw() {
    const { list, filter, q } = S.keys;
    const shown = list.filter((k) =>
      (filter === 'all' || (filter === 'unused' && !k.redeemed) || (filter === 'redeemed' && k.redeemed) || (filter === 'sellauth' && String(k.source).startsWith('sellauth')) || (filter === 'resellers' && k.owner)) &&
      (!q || `${k.code} ${k.note} ${k.owner || ''} ${k.serverLink || ''} ${k.redeemedInvite || ''}`.toLowerCase().includes(q)));
    summary.textContent = `${num(shown.length)} shown · ${num(list.filter((k) => !k.redeemed).length)} unused of ${num(list.length)}`;
    const rows = shown.slice(0, 300).map((k) => el('tr', {},
      el('td', { class: 'mono', text: k.code }),
      el('td', { class: 'num', text: k.redeemed ? `${k.delivered}/${k.boosts}` : k.boosts }),
      el('td', {}, pillFor(k.redeemed ? 'redeemed' : 'unused')),
      el('td', {}, el('span', { class: `pill ${String(k.source).startsWith('sellauth') ? 'brand' : ''}`, text: k.source })),
      el('td', {}, k.owner ? el('span', { class: 'pill brand', text: k.owner }) : el('span', { class: 'muted', text: 'you' })),
      el('td', { class: 'muted', text: k.redeemedInvite || k.serverLink || k.note || '—' }),
      el('td', { class: 'muted', text: ago(k.createdAt) }),
      el('td', { class: 'act' },
        iconBtn('copy', 'Copy key', () => copy(k.code, 'Key copied')),
        iconBtn('trash', 'Delete key', async () => { await api(`/admin/keys/${encodeURIComponent(k.code)}`, { method: 'DELETE' }); await refreshKeys(); }, 'del'))));
    listHost.replaceChildren(
      table([{ label: 'Key' }, { label: 'Boosts', num: true }, { label: 'Status' }, { label: 'Source', hide: true }, { label: 'Owner' }, { label: 'Note / server' }, { label: 'Created', hide: true }, { label: '' }], rows, 'No key matches.'),
      shown.length > 300 ? el('p', { class: 'muted', style: 'margin-top:8px', text: `Showing the first 300 of ${num(shown.length)} — use search or filters.` }) : null);
  }

  const unusedCodes = () => S.keys.list.filter((k) => !k.redeemed).map((k) => k.code);
  const bulkDelete = (scope, label) => btn(label, async () => {
    if (!confirm(`${label}? This cannot be undone.`)) return;
    await api(`/admin/keys?scope=${scope}`, { method: 'DELETE' });
    toast(label);
    await refreshKeys();
  }, 'btn-danger btn-sm');

  root.append(gen, card('All keys', null, el('div', { style: 'display:grid;gap:12px' },
    el('div', { class: 'actions', style: 'justify-content:space-between' }, el('div', { class: 'actions' }, seg, search, summary),
      el('div', { class: 'actions' },
        btn('Copy unused', () => { const c = unusedCodes(); if (!c.length) throw new Error('No unused key'); return copy(c.join('\n'), `${c.length} keys copied`); }),
        btn('Export unused', () => { const c = unusedCodes(); if (!c.length) throw new Error('No unused key'); download('unused-keys.txt', c.join('\n')); }),
        bulkDelete('redeemed', 'Delete redeemed'), bulkDelete('unused', 'Delete unused'))),
    listHost)));
  draw();
}

/* ============================ TOKEN CHECKER ============================== */
// Platform pool only (resellers have their own Checker). Free (provider check):
// up to 1,000 tokens a pass — from the unused stock, or tokens pasted here.
let adminDoneCheck = null;   // { id, text } — replaces stale results after a purge / import
const adminPasted = (id) => { try { return localStorage.getItem('nb_pasted_check') === id; } catch { return false; } };

function segControl(options, current, onPick) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  const buttons = options.map((o) => el('button', { type: 'button', 'aria-pressed': String(o.id === current), text: o.label }));
  buttons.forEach((b, i) => b.addEventListener('click', () => {
    buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onPick(options[i].id);
  }));
  wrap.append(...buttons);
  return wrap;
}
const pasteTally = (text) => new Set(String(text || '').split(/\r?\n/).map((l) => l.trim().split(':').pop().trim()).filter(Boolean)).size;

function checkerCard(unused, reload) {
  let mode = unused > 0 ? 'stock' : 'paste';
  const host = el('div', { class: 'stack' });
  const form = el('div', { class: 'stack' });
  const pasted = el('textarea', { rows: 6, spellcheck: 'false', placeholder: 'email:password:TOKEN\nTOKEN\nuser:pass:TOKEN' });
  const tally = el('p', { class: 'muted' });
  pasted.addEventListener('input', () => { const n = pasteTally(pasted.value); tally.textContent = `${n} token${n === 1 ? '' : 's'} pasted · max 1,000`; });

  function drawForm() {
    const go = el('button', {
      type: 'button', class: 'btn btn-primary btn-sm', disabled: mode === 'stock' && !unused ? true : null,
      text: mode === 'stock' ? `Check my stock (${num(Math.min(unused, 1000))})` : 'Check pasted tokens',
      onclick: act(async () => {
        if (mode === 'paste' && !pasteTally(pasted.value)) throw new Error('Paste at least one token');
        const r = await api('/admin/tokens/check', { method: 'POST', body: mode === 'paste' ? { tokens: pasted.value } : {} });
        toast(r.message); adminDoneCheck = null;
        if (mode === 'paste') { try { localStorage.setItem('nb_pasted_check', r.check.id); } catch { /* private mode */ } }
        watch(r.check.id);
      }),
    });
    form.replaceChildren(
      mode === 'paste' ? el('label', {}, 'Tokens to check', pasted) : null,
      mode === 'paste' ? tally : null,
      mode === 'stock' && !unused ? el('div', { class: 'note warn', text: 'Your stock is empty — paste tokens to check them, or add stock first.' }) : null,
      el('div', { class: 'actions' }, go));
  }

  const dead = (label, n, statuses, id) => btn(`${label} (${num(n)})`, async () => {
    if (!n) throw new Error('Nothing to delete');
    if (!confirm(`${label}: ${n} token${n > 1 ? 's' : ''} will be removed from your stock.`)) return;
    const r = await api(`/admin/tokens/check/${id}/purge`, { method: 'POST', body: { statuses } });
    adminDoneCheck = { id, text: `${r.deleted} token${r.deleted === 1 ? '' : 's'} deleted from your stock. Run a new check to refresh.` };
    toast(r.message); await reload();
  }, 'btn-danger btn-sm');

  async function showResults(id) {
    const r = await api(`/admin/tokens/check/${id}/results`), m = r.summary;
    host.replaceChildren(
      el('div', { class: 'grid g4' }, kpi('Valid', num(m.valid), `${num(m.nitro)} with Nitro`), kpi('Locked', num(m.locked), 'phone / email / re-verify'),
        kpi('Invalid', num(m.invalid), 'dead tokens', m.invalid ? 'bad' : ''), kpi('Free slots', num(m.freeSlots), 'on valid accounts')),
      el('div', { class: 'actions' },
        adminPasted(id) ? btn(`Add valid to my stock (${num(m.valid)})`, async () => {
          if (!m.valid) throw new Error('No valid token to add');
          const a = await api(`/admin/tokens/check/${id}/import`, { method: 'POST', body: { statuses: ['valid'] } });
          adminDoneCheck = { id, text: `${a.added} valid token${a.added === 1 ? '' : 's'} added to your stock${a.alreadyInStock ? ` (${a.alreadyInStock} already there)` : ''}.` };
          toast(a.message); await reload();
        }, 'btn-primary btn-sm') : null,
        dead('Delete invalid', m.invalid, ['invalid'], id), dead('Delete locked', m.locked, ['locked'], id),
        el('span', { class: 'muted', text: `checked ${ago(r.check.finishedAt || r.check.createdAt)}` })),
      table([{ label: 'Token' }, { label: 'Result' }, { label: 'Nitro' }, { label: 'Free slots', num: true }, { label: 'Lock', hide: true }, { label: 'Age', hide: true }],
        r.rows.map((x) => el('tr', {}, el('td', { class: 'mono', text: x.token || '—' }), el('td', {}, pillFor(x.status)),
          el('td', { class: 'muted', text: x.nitro ? (x.nitroDays != null ? `${x.nitroDays}d left` : 'yes') : '—' }),
          el('td', { class: 'num', text: x.boostFree == null ? '—' : x.boostFree }), el('td', { class: 'muted', text: x.lockType || '—' }),
          el('td', { class: 'muted', text: x.ageDays == null ? '—' : `${x.ageDays}d` }))), 'No result.'),
      r.total > r.rows.length ? el('p', { class: 'muted', text: `Showing the ${r.rows.length} first of ${num(r.total)} (problems first).` }) : null);
  }
  function progress(c) {
    const pct = c.total ? Math.min(100, Math.round(((c.checked || 0) / c.total) * 100)) : 0;
    host.replaceChildren(el('div', { class: 'cover-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` })),
      el('p', { class: 'muted', text: `${num(c.checked || 0)} of ${num(c.total)} checked…` }));
  }
  async function tick(id) {
    const { check } = await api(`/admin/tokens/check/${id}`);
    if (check.status === 'running') return progress(check);
    clearInterval(checkTimer);
    if (check.status === 'completed') return showResults(id);
    host.replaceChildren(el('div', { class: 'note warn', text: 'The check did not finish. Nothing was charged — run it again.' }));
  }
  function watch(id) {
    clearInterval(checkTimer);
    progress({ total: 0, checked: 0 });
    tick(id).catch((e) => toast(e.message, 'error'));
    checkTimer = setInterval(() => tick(id).catch(() => {}), 3000);
  }

  api('/admin/tokens/check').then(({ check }) => {
    if (!check) return;
    if (check.status === 'running') return watch(check.id);
    if (adminDoneCheck && adminDoneCheck.id === check.id) return host.replaceChildren(el('div', { class: 'note', text: adminDoneCheck.text }));
    if (check.status === 'completed') showResults(check.id).catch(() => {});
  }).catch(() => {});

  drawForm();
  return card('Token checker', 'Valid, locked, Nitro, free boost slots — up to 1,000 tokens per pass.',
    el('div', { class: 'stack' }, segControl([{ id: 'stock', label: `My stock (${num(unused)})` }, { id: 'paste', label: 'Paste tokens' }], mode, (m) => { mode = m; drawForm(); }), form, host));
}

async function vChecker(root) {
  const st = await api('/admin/stats');
  root.append(
    el('p', { class: 'muted', text: 'Free. Checks your own pool — each premium account has the same tool for theirs.' }),
    checkerCard(st.stock.unused, () => paint(VIEWS.find((v) => v.id === 'checker'), false)));
}

/* ============================== STOCK =================================== */
async function vStock(root) {
  const data = await api('/admin/tokens');
  const add = el('textarea', { rows: 6, placeholder: 'email:password:TOKEN\nTOKEN\nuser:pass:TOKEN' });
  const bulk = el('textarea', { rows: 8, placeholder: 'Press “Load unused” to edit the whole unused pool as text' });
  const reload = () => paint(VIEWS.find((v) => v.id === 'stock'), false);

  root.append(
    el('p', { class: 'muted', text: 'This is your own pool. Each premium account has a separate stock (see Premium) — keys never draw from another owner’s tokens.' }),
    el('div', { class: 'grid g4' },
      kpi('Unused', num(data.unused), 'ready to be used for a boost'),
      kpi('Used', num(data.used), 'already spent on a boost'),
      kpi('Listed', num(data.total), 'newest 500 shown below')),
    el('div', { class: 'grid g2' },
      card('Add tokens', 'One per line. Duplicates are ignored.', el('div', { style: 'display:grid;gap:10px' }, add,
        el('div', { class: 'actions' }, btn('Add to stock', async () => {
          const tokens = add.value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
          if (!tokens.length) throw new Error('Paste at least one token');
          const d = await api('/admin/tokens', { method: 'POST', body: { tokens } });
          toast(d.message); add.value = ''; await reload();
        }, 'btn-primary')))),
      card('Edit unused pool', 'Load, fix or remove lines, then save — used tokens are never touched.', el('div', { style: 'display:grid;gap:10px' }, bulk,
        el('div', { class: 'actions' },
          btn('Load unused', async () => { const d = await api('/admin/tokens/export?status=unused'); bulk.value = d.tokens.join('\n'); toast(`${d.tokens.length} loaded`); }),
          btn('Copy', () => copy(bulk.value, 'Copied')),
          btn('Save changes', async () => {
            const d = await api('/admin/tokens/unused', { method: 'PUT', body: { tokens: bulk.value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean) } });
            toast(d.message); await reload();
          }, 'btn-primary'))))),
    card('Tokens', null, table(
      [{ label: 'Token' }, { label: 'Status' }, { label: 'Server', hide: true }, { label: 'Added', hide: true }, { label: '' }],
      data.tokens.map((t) => el('tr', {},
        el('td', { class: 'mono', text: t.preview }),
        el('td', {}, pillFor(t.status)),
        el('td', { class: 'muted', text: t.serverName || t.server || '—' }),
        el('td', { class: 'muted', text: ago(t.createdAt) }),
        el('td', { class: 'act' },
          iconBtn('copy', 'Copy full token', async () => { const r = await api(`/admin/tokens/${t.id}/raw`); await copy(r.token, 'Token copied'); }),
          iconBtn('trash', 'Delete token', async () => { await api(`/admin/tokens/${t.id}`, { method: 'DELETE' }); await reload(); }, 'del')))),
      'The stock is empty — add tokens above.'),
    btn('Delete all tokens', async () => {
      if (!confirm('Delete ALL stock tokens (used and unused)? This cannot be undone.')) return;
      await api('/admin/tokens', { method: 'DELETE' }); toast('Stock cleared'); await reload();
    }, 'btn-danger btn-sm')));
}

/* ============================== USERS =================================== */
async function vUsers(root) {
  const { users } = await api('/admin/users');
  const reload = () => paint(VIEWS.find((v) => v.id === 'users'), false);
  const holder = el('div');
  let q = '', role = 'all';

  const draw = () => {
    const list = users.filter((u) => (!q || u.username.toLowerCase().includes(q))
      && (role === 'all' || (role === 'reseller' ? u.reseller : role === 'admin' ? u.role === 'admin' : u.role !== 'admin' && !u.reseller)));
    holder.replaceChildren(table(
      [{ label: 'Username' }, { label: 'Role' }, { label: 'Premium' }, { label: 'Balance', num: true }, { label: 'Joined', hide: true }, { label: 'Add / remove funds' }, { label: '' }],
      list.map((u) => {
        const amount = el('input', { type: 'number', step: '0.01', placeholder: '10.00', 'aria-label': `Amount for ${u.username}` });
        return el('tr', {},
          el('td', {}, el('a', { href: `#/user/${u.id}`, text: u.username })),
          el('td', {}, el('span', { class: `pill ${u.role === 'admin' ? 'brand' : ''}`, text: u.role })),
          el('td', {}, u.role === 'admin' ? el('span', { class: 'muted', text: '—' }) : u.reseller
            ? el('span', { class: 'inline-in' }, el('span', { class: 'pill ok', text: 'premium' }), btn('Disable', async () => {
              if (!confirm(`Remove premium access from ${u.username}? Their stock and keys are kept but stop working.`)) return;
              const d = await api(`/admin/users/${u.id}/reseller`, { method: 'PATCH', body: { enabled: false } }); toast(d.message); await reload();
            }))
            : btn('Make premium', async () => {
              const d = await api(`/admin/users/${u.id}/reseller`, { method: 'PATCH', body: { enabled: true } }); toast(d.message); await reload();
            })),
          el('td', { class: 'num mono', text: usd(u.balance) }),
          el('td', { class: 'muted', text: ago(u.createdAt) }),
          el('td', {}, el('span', { class: 'inline-in' }, amount, btn('Apply', async () => {
            const d = await api(`/admin/users/${u.id}/balance`, { method: 'PATCH', body: { amount: Number(amount.value) } });
            toast(d.message); await reload();
          }))),
          el('td', { class: 'act' },
            el('a', { class: 'btn btn-ghost btn-sm', href: `#/user/${u.id}`, text: 'Open' }),
            u.role === 'admin' ? null : iconBtn('trash', 'Delete account', async () => {
              if (!confirm(`Delete ${u.username}? Their balance is lost.`)) return;
              await api(`/admin/users/${u.id}`, { method: 'DELETE' }); await reload();
            }, 'del')));
      }), 'No account matches.'));
  };

  const search = el('input', { type: 'search', placeholder: 'Search a username…', style: 'max-width:220px', 'aria-label': 'Search accounts', oninput: () => { q = search.value.trim().toLowerCase(); draw(); } });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter accounts' },
    [['all', 'All'], ['user', 'Boosters'], ['reseller', 'Premium'], ['admin', 'Admins']].map(([id, label]) =>
      el('button', { type: 'button', 'aria-pressed': String(role === id), text: label, onclick: (e) => {
        role = id; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); draw();
      } })));
  draw();
  root.append(card('Accounts', `${num(users.length)} total · open an account to see everything about it`, holder, [search, seg,
    csvBtn('users', [
      { label: 'Username', get: (u) => u.username }, { label: 'Role', get: (u) => u.role }, { label: 'Premium', get: (u) => (u.reseller ? 'yes' : 'no') },
      { label: 'Balance', get: (u) => u.balance }, { label: 'Joined', get: (u) => u.createdAt },
    ], () => users)]));
}

/* ============================ RESELLERS ================================= */
async function vResellers(root) {
  const [{ resellers }, { users }] = await Promise.all([api('/admin/resellers'), api('/admin/users')]);
  const reload = () => paint(VIEWS.find((v) => v.id === 'resellers'), false);
  const candidates = users.filter((u) => u.role !== 'admin' && !u.reseller);

  const pick = el('select', { 'aria-label': 'Account to promote' },
    el('option', { value: '', text: candidates.length ? 'Choose an account…' : 'No eligible account yet' }),
    candidates.map((u) => el('option', { value: u.id, text: u.username })));
  const price = el('input', { type: 'number', step: '0.001', min: 0, max: 100, placeholder: '0 = free' });

  const totals = resellers.reduce((t, r) => ({ stock: t.stock + r.stockUnused, keys: t.keys + r.keysUnused, boosts: t.boosts + r.boosts }), { stock: 0, keys: 0, boosts: 0 });

  root.append(
    el('div', { class: 'grid g4' },
      kpi('Premium', num(resellers.length), 'accounts with premium access'),
      kpi('Their tokens', num(totals.stock), 'unused, all premium accounts'),
      kpi('Their keys', num(totals.keys), 'unused, all premium accounts'),
      kpi('Boosts delivered', num(totals.boosts), 'through premium accounts, all time')),
    card('Add a premium account', 'The customer registers on the customer panel first, then appears here.', el('div', { style: 'display:grid;gap:12px' },
      el('div', { class: 'row' },
        el('label', { style: 'flex:2 1 220px' }, 'Account', pick),
        el('label', {}, 'Price per boost (USD)', price),
        el('button', {
          type: 'button', class: 'btn btn-primary', text: 'Enable premium',
          onclick: act(async () => {
            if (!pick.value) throw new Error('Choose an account');
            const d = await api(`/admin/users/${pick.value}/reseller`, { method: 'PATCH', body: { enabled: true, boostPrice: Number(price.value || 0) } });
            toast(d.message); await reload();
          }),
        })),
      el('p', { class: 'muted', text: 'They get Files (own stock), Keys, API and a Redeem Page of their own. The price is taken from their wallet for every boost actually delivered — leave 0 to let them sell for free, or top up their balance in Users.' }))),
    card('Premium', 'Stock, keys and volume per premium account', table(
      [{ label: 'Premium' }, { label: 'Stock', num: true }, { label: 'Keys', num: true }, { label: 'Boosts · joins', num: true }, { label: 'Sales', num: true }, { label: 'Balance', num: true }, { label: 'Price / boost' }, { label: 'Page' }, { label: 'API' }, { label: '' }],
      resellers.map((r) => {
        const p = el('input', { type: 'number', step: '0.001', min: 0, max: 100, value: r.boostPrice, 'aria-label': `Price per boost for ${r.username}` });
        return el('tr', {},
          el('td', {}, el('a', { href: `#/user/${r.id}`, text: r.username }), r.sellauth ? el('span', { class: 'pill ok', style: 'margin-left:8px', title: 'SellAuth dynamic delivery is set up', text: 'SellAuth' }) : null),
          el('td', { class: 'num', text: `${num(r.stockUnused)} / ${num(r.stockUnused + r.stockUsed)}` }),
          el('td', { class: 'num', text: `${num(r.keysUnused)} / ${num(r.keysTotal)}` }),
          el('td', { class: 'num', title: 'Boosts delivered · accounts joined', text: `${num(r.boosts)} · ${num(r.joins)}` }),
          el('td', { class: 'num', text: num(r.sales) }),
          el('td', { class: `num mono${r.boostPrice > 0 && r.balance < r.boostPrice * 2 ? ' warn-text' : ''}`, text: usd(r.balance) }),
          el('td', {}, el('span', { class: 'inline-in' }, p, btn('Save', async () => {
            const d = await api(`/admin/users/${r.id}/reseller`, { method: 'PATCH', body: { boostPrice: Number(p.value || 0) } }); toast(d.message); await reload();
          }))),
          el('td', { style: 'white-space:nowrap' }, r.page ? el('a', { class: 'mono', href: `/r/${encodeURIComponent(r.page)}`, target: '_blank', rel: 'noopener', title: `${location.origin}/r/${r.page}`, text: r.page }) : el('span', { class: 'muted', text: '—' })),
          el('td', {}, r.apiKey ? el('span', { class: 'inline-in' }, el('span', { class: 'pill brand', text: `${r.apiKey.slice(4, 10)}…` }), btn('Revoke', async () => {
            if (!confirm(`Revoke the API key of ${r.username}?`)) return;
            const d = await api(`/admin/resellers/${r.id}/revoke-api`, { method: 'POST' }); toast(d.message); await reload();
          })) : el('span', { class: 'muted', text: 'none' })),
          el('td', { class: 'act' },
            el('a', { class: 'btn btn-ghost btn-sm', href: `#/user/${r.id}`, text: 'Manage' }), ' ',
            btn('Disable', async () => {
              if (!confirm(`Remove premium access from ${r.username}? Their keys stop working until you enable them again.`)) return;
              const d = await api(`/admin/users/${r.id}/reseller`, { method: 'PATCH', body: { enabled: false } }); toast(d.message); await reload();
            }, 'btn-danger btn-sm')));
      }),
      'No premium account yet — enable one above.')));
}

/* ============================= SELLAUTH ================================= */
async function vSellauth(root) {
  const [cfg, log] = await Promise.all([api('/admin/sellauth'), api('/admin/sellauth/deliveries')]);
  const reload = () => paint(VIEWS.find((v) => v.id === 'sellauth'), false);
  const url = `${location.origin}/api/sellauth/deliver`;

  const secret = el('input', { type: 'password', autocomplete: 'off', placeholder: cfg.secretSet ? '•••••••• (saved — type to replace)' : 'Paste your SellAuth webhook secret', disabled: cfg.secretFromEnv });
  const def = el('input', { type: 'number', min: 0, max: 1000, value: cfg.defaultBoosts || '', placeholder: 'None' });
  const field = el('input', { type: 'text', maxlength: 60, value: cfg.linkField || 'Server Link' });
  const mode = el('select', { 'aria-label': 'Delivery mode' },
    el('option', { value: 'direct', text: 'Boost the server directly (no key)' }), el('option', { value: 'key', text: 'Send a key' }));
  mode.value = cfg.deliveryMode || 'direct';

  const connection = card('Connection', 'Give SellAuth this URL and this secret.', el('div', { style: 'display:grid;gap:14px' },
    el('label', {}, 'Webhook URL',
      el('div', { class: 'copybox' }, el('input', { type: 'text', readonly: true, value: url }), btn('Copy', () => copy(url, 'URL copied')))),
    el('div', { class: 'row' },
      el('label', { style: 'flex:2 1 260px' }, 'Webhook secret', secret),
      el('label', {}, 'Fallback boosts', def),
      el('label', {}, 'Custom field name', field),
      el('label', {}, 'On each order', mode),
      el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Save',
        onclick: act(async () => {
          const body = { defaultBoosts: Number(def.value || 0), linkField: field.value.trim(), deliveryMode: mode.value };
          if (!cfg.secretFromEnv && secret.value.trim()) body.webhookSecret = secret.value.trim();
          const d = await api('/admin/sellauth', { method: 'PATCH', body });
          toast(d.message); await reload();
        }),
      })),
    el('div', { class: 'actions' },
      el('span', { class: `pill ${cfg.secretSet ? 'ok' : 'bad'}`, text: cfg.secretSet ? 'Secret configured' : 'No secret — deliveries are refused' }),
      cfg.secretFromEnv ? el('span', { class: 'muted', text: 'Set through SELLAUTH_WEBHOOK_SECRET' }) : null),
    el('div', { class: 'note', text: cfg.deliveryMode === 'key'
      ? 'Key mode: each order receives a key. Add ?mode=direct to a product URL to boost directly for that product only.'
      : 'Direct mode: the server from the custom field is boosted right away and no key is sent. If the link is missing or the boost cannot start (no stock), a key is sent instead. Add ?mode=key to a product URL to send keys for that product.' }),
    cfg.serverless && !cfg.cronConfigured
      ? el('div', { class: 'note warn', text: 'Serverless hosting detected: direct boosts need a pinger to keep moving. Set CRON_SECRET and call /api/cron/sync every minute (see docs/SELLAUTH_DIRECT.md). Until then they only advance when you open this page.' })
      : null));

  const guide = card('Set up a product', null, el('ol', { class: 'steps' },
    el('li', {}, el('span', {}, 'In SellAuth open the product → ', el('b', { text: 'Deliverables' }), ' → choose ', el('b', { text: 'Dynamic Delivery' }), '.')),
    el('li', {}, el('span', {}, 'Webhook URL: the one above. To fix the amount right in the URL add ', el('code', { text: '?boosts=14' }), ' (best when a product = one amount).')),
    el('li', {}, el('span', {}, 'Or link the product / variant ID below. Without either, the number in its name is used (“14 Boosts”), then the fallback amount.')),
    el('li', {}, el('span', {}, 'Direct mode: add a ', el('b', { text: 'Custom Field' }), ' named ', el('code', { text: 'Server Link' }), ' (required) to the product — the buyer pastes their Discord invite there and that server is boosted immediately. (In key mode the invite is only saved with the key.)')),
    el('li', {}, el('span', {}, 'Copy the secret from ', el('b', { text: 'Storefront → Configure → Miscellaneous' }), ' and save it here. Each order item receives one fresh key.'))));

  const sid = el('input', { type: 'text', placeholder: 'Product or variant ID' });
  const slabel = el('input', { type: 'text', placeholder: 'Label (optional)', maxlength: 80 });
  const sboosts = el('input', { type: 'number', min: 1, placeholder: 'Boosts' });
  const links = card('Product links', 'Match a SellAuth ID to a boost amount.', el('div', { style: 'display:grid;gap:14px' },
    el('div', { class: 'row' }, el('label', {}, 'SellAuth ID', sid), el('label', {}, 'Label', slabel), el('label', { style: 'flex:0 1 110px' }, 'Boosts', sboosts),
      el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Link',
        onclick: act(async () => {
          await api('/admin/sellauth/products', { method: 'POST', body: { sellauthId: sid.value, label: slabel.value, boosts: Number(sboosts.value) } });
          toast('Product linked'); await reload();
        }),
      })),
    table([{ label: 'ID' }, { label: 'Label' }, { label: 'Boosts', num: true }, { label: '' }],
      cfg.products.map((p) => el('tr', {}, el('td', { class: 'mono', text: p.sellauthId }), el('td', { text: p.label || '—' }), el('td', { class: 'num', text: p.boosts }),
        el('td', { class: 'act' }, iconBtn('trash', 'Remove link', async () => { await api(`/admin/sellauth/products/${p.id}`, { method: 'DELETE' }); await reload(); }, 'del')))),
      'No link yet.')));

  const rows = [];
  log.deliveries.forEach((d) => {
    const detail = el('pre', { class: 'payload hidden', text: JSON.stringify(d.payload ?? {}, null, 2) });
    rows.push(el('tr', {},
      el('td', { class: 'muted', text: ago(d.createdAt) }),
      el('td', { class: 'mono', text: d.invoiceId || '—' }),
      el('td', { text: d.productName || d.productId || '—' }),
      el('td', { class: 'num', text: d.boosts ?? '—' }),
      el('td', {}, d.direct ? el('span', { class: 'pill ok', text: 'boosted directly' }) : el('span', { class: 'mono', text: d.key || '—' })),
      el('td', {}, d.serverLink ? el('span', { class: 'mono', text: d.serverLink }) : (d.status === 'delivered' ? el('span', { class: 'pill warn', text: 'no link' }) : '—')),
      el('td', {}, d.direct && d.job ? el('span', {}, pillFor(d.job.jobStatus || 'running'), ' ', el('span', { class: 'muted', text: `${d.job.delivered ?? 0}/${d.job.requested ?? d.boosts}` }), d.job.jobId ? el('span', {}, ' ', el('a', { href: `#/job/${d.job.jobId}`, text: 'job' })) : null) : pillFor(d.status),
        d.status === 'delivered' && d.error ? el('div', { class: 'muted', text: d.error }) : null,
        d.status === 'error'
        ? el('div', { style: 'margin-top:4px' }, el('span', { class: 'muted', text: d.error }), ' ',
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Payload', onclick: () => detail.classList.toggle('hidden') }), detail)
        : null)));
  });
  const deliveries = card('Deliveries', 'Your own shop — latest 100 calls (premium accounts have their own log in their panel). A failed one shows the payload SellAuth sent, so you can see which ID to link.',
    table([{ label: 'When' }, { label: 'Invoice', hide: true }, { label: 'Product' }, { label: 'Boosts', num: true }, { label: 'Key / delivery' }, { label: 'Server', hide: true }, { label: 'Result' }], rows, 'No delivery yet — place a test order.'));

  root.append(el('div', { class: 'grid g-main' }, connection, guide), links, deliveries);
}

/* ============================= SETTINGS ================================= */
// Discord alerts: a webhook the panel posts to for orders, finished / failed boosts and low stock.
function alertsCard(al) {
  const url = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Discord webhook URL',
    placeholder: al.configured ? `Saved (…${al.tail}) — paste a new URL to replace it` : 'https://discord.com/api/webhooks/…' });
  const names = { orders: 'New orders', completed: 'Boost completed', failed: 'Boost failed', lowstock: 'Low stock' };
  const boxes = {};
  const checks = Object.keys(names).map((k) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': names[k] });
    cb.checked = Boolean(al.events[k]); boxes[k] = cb;
    return el('label', { class: 'check' }, cb, ' ', names[k]);
  });
  const low = el('input', { type: 'number', min: 0, max: 100000, value: al.lowStock, 'aria-label': 'Low stock threshold', style: 'max-width:110px' });
  const readEvents = () => Object.fromEntries(Object.keys(boxes).map((k) => [k, boxes[k].checked]));
  return card('Discord alerts', 'Get a message in a Discord channel for each order, finished or failed boost, and when stock runs low.', el('div', { style: 'display:grid;gap:14px' },
    el('label', {}, 'Webhook URL', url),
    el('div', { class: 'muted', text: 'Discord: channel settings → Integrations → Webhooks → New webhook → Copy Webhook URL.' }),
    el('div', {}, el('div', { class: 'muted', text: 'Send me an alert for' }), el('div', { class: 'emb-row' }, checks)),
    el('label', {}, 'Low stock: alert when a pool has fewer tokens than', low),
    el('div', { class: 'actions' },
      btn('Save', async () => {
        const body = { events: readEvents(), lowStock: Number(low.value) };
        if (url.value.trim()) body.webhookUrl = url.value.trim();
        const r = await api('/admin/alerts', { method: 'PATCH', body });
        toast(r.message); url.value = ''; url.placeholder = `Saved (…${r.tail}) — paste a new URL to replace it`;
      }, 'btn-primary btn-sm'),
      btn('Send test message', async () => { const r = await api('/admin/alerts/test', { method: 'POST' }); toast(r.message); }, 'btn-ghost btn-sm'),
      al.configured ? btn('Remove webhook', async () => {
        if (!confirm('Stop sending alerts to Discord?')) return;
        await api('/admin/alerts', { method: 'PATCH', body: { webhookUrl: '' } }); toast('Alerts turned off'); paint(VIEWS.find((v) => v.id === 'settings'), false);
      }, 'btn-danger btn-sm') : null)));
}

async function vSettings(root) {
  const s = await api('/admin/settings');
  const em = await api('/admin/embed').catch(() => null);
  const al = await api('/admin/alerts').catch(() => null);
  const price = el('input', { type: 'number', step: '0.001', min: 0, value: s.captchaCost });
  const support = el('input', { type: 'url', placeholder: 'https://discord.gg/yourinvite', value: s.supportUrl || '' });
  const pmUrl = el('input', { type: 'url', placeholder: 'https://youtu.be/…   ·   https://vimeo.com/…   ·   https://…/video.mp4', value: s.premiumVideoUrl || '' });
  const pmTitle = el('input', { type: 'text', maxlength: 80, placeholder: 'Premium', value: s.premiumTitle || '' });
  const pmText = el('textarea', { rows: 3, maxlength: 800, placeholder: 'Short text shown above the video (optional)' });
  pmText.value = s.premiumText || '';
  const nu = el('input', { type: 'text', autocomplete: 'off', placeholder: 'New username' });
  const np = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (6+ characters)' });

  if (em) {
    root.append(embedEditor({
      heading: 'Link embed — main site', sub: 'The card shown when your site link is pasted in Discord, Telegram, X…',
      withSite: true, values: em.custom,
      def: { siteName: em.defaults.siteName, title: em.defaults.title, description: em.defaults.description, color: em.defaults.color, thumb: '/logo.png' },
      save: async (b) => {
        await api('/admin/embed', { method: 'PATCH', body: b });
        toast('Link embed saved — Discord may take a few minutes to refresh old previews');
      },
    }));
  }
  if (al) root.append(alertsCard(al));
  root.append(el('div', { class: 'grid g2' },
    card('Pricing', 'What a booster pays per solved captcha (BYOT mode).', el('div', { class: 'row' }, el('label', {}, 'USD per solve', price),
      btn('Save', async () => { await api('/admin/settings', { method: 'PATCH', body: { captchaCost: Number(price.value) } }); toast('Pricing saved'); }, 'btn-primary'))),
    card('Support link', 'Shown to a customer when some boosts could not be delivered.', el('div', { class: 'row' }, el('label', { style: 'flex:2 1 220px' }, 'URL', support),
      btn('Save', async () => { await api('/admin/settings', { method: 'PATCH', body: { supportUrl: support.value.trim() } }); toast('Support link saved'); }, 'btn-primary')))),
    card('Premium tab', 'Shown to accounts that do not have premium yet. Paste a YouTube or Vimeo link, or a direct https link to an .mp4 / .webm file. Leave the link empty for no video.', el('div', { style: 'display:grid;gap:12px' },
      el('label', {}, 'Video link', pmUrl), el('label', {}, 'Title', pmTitle), el('label', {}, 'Description', pmText),
      el('div', {}, btn('Save', async () => {
        await api('/admin/settings', { method: 'PATCH', body: { premiumVideoUrl: pmUrl.value.trim(), premiumTitle: pmTitle.value.trim(), premiumText: pmText.value.trim() } });
        toast('Premium tab saved');
      }, 'btn-primary')))),
    card('Admin account', 'Replaces the current admin login. You stay signed in.', el('div', { class: 'row' }, el('label', {}, 'Username', nu), el('label', {}, 'Password', np),
      btn('Update account', async () => {
        if (!confirm('Replace the admin username and password?')) return;
        const d = await api('/admin/credentials', { method: 'PATCH', body: { username: nu.value.trim(), password: np.value } });
        setSession(d.token, d.panelToken); nu.value = np.value = ''; toast('Admin account updated');
      }, 'btn-primary'))),
    el('p', { class: 'muted', text: 'The panel password is set with the ADMIN_PANEL_PASSWORD environment variable.' }));
}

/* ============================ LINK EMBED EDITOR ========================= */
// Any image -> JPEG data URL (≤ 1200px, ≤ ~300 KB) for the card shown when a link is pasted in Discord & co.
function fileToEmbedImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Use a PNG, JPG, WEBP or GIF image'));
    if (file.size > 8 * 1024 * 1024) return reject(new Error('Image is too big (8 MB max)'));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read that file'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image'));
      img.onload = () => {
        let k = Math.min(1200 / img.width, 1200 / img.height, 1);
        for (let round = 0; round < 6; round++, k *= 0.8) {
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          const g = c.getContext('2d');
          g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, c.width, c.height);
          g.drawImage(img, 0, 0, c.width, c.height);
          for (const q of [0.88, 0.76, 0.62]) {
            const out = c.toDataURL('image/jpeg', q);
            if (out.startsWith('data:image/jpeg') && out.length <= 420000) return resolve(out);
          }
        }
        reject(new Error('That image is too detailed — try a smaller one'));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// o = { heading, sub, values:{siteName,title,description,color,image}, withSite, def:{siteName,title,description,color,thumb}, save(body) }
function embedEditor(o) {
  const d = { siteName: o.values.siteName || '', title: o.values.title || '', description: o.values.description || '', color: o.values.color || '', image: o.values.image || '', dirty: false };
  const site = el('input', { type: 'text', maxlength: 40, value: d.siteName, placeholder: o.def.siteName, 'aria-label': 'Site name' });
  const title = el('input', { type: 'text', maxlength: 70, value: d.title, placeholder: o.def.title, 'aria-label': 'Embed title' });
  const desc = el('textarea', { maxlength: 300, placeholder: o.def.description, 'aria-label': 'Embed description', style: 'min-height:84px;font-family:var(--body);font-size:13.5px' });
  desc.value = d.description;
  const picker = el('input', { type: 'color', value: d.color || o.def.color, 'aria-label': 'Embed colour', style: 'height:38px;padding:3px;cursor:pointer;width:56px' });
  const hex = el('input', { type: 'text', maxlength: 7, value: d.color, placeholder: o.def.color, class: 'mono', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Embed colour code', style: 'max-width:130px' });
  const url = el('input', { type: 'url', placeholder: 'or paste an image link (https://…)', 'aria-label': 'Image link' });
  const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden' });
  const thumbPrev = el('img', { class: 'emb-img-prev', alt: '' });

  const cardEl = el('div', { class: 'emb-card' });
  const prev = el('div', { class: 'emb' }, cardEl, el('div', { class: 'emb-note', text: 'Preview — Discord, Telegram and X show something very close to this.' }));
  const draw = () => {
    prev.style.setProperty('--emb-color', d.color || o.def.color);
    const thumb = !d.image && o.def.thumb;
    cardEl.className = `emb-card${thumb ? ' has-thumb' : ''}`;
    cardEl.replaceChildren(
      el('div', { class: 'emb-site', text: (o.withSite ? d.siteName : '') || o.def.siteName }),
      el('div', { class: 'emb-title', text: d.title || o.def.title }),
      el('div', { class: 'emb-desc', text: d.description || o.def.description }),
      d.image ? el('img', { class: 'emb-img', src: d.image, alt: '' }) : null,
      thumb ? el('img', { class: 'emb-thumb', src: thumb, alt: '' }) : null);
    thumbPrev.src = d.image || ''; thumbPrev.classList.toggle('hidden', !d.image);
  };
  site.addEventListener('input', () => { d.siteName = site.value; draw(); });
  title.addEventListener('input', () => { d.title = title.value; draw(); });
  desc.addEventListener('input', () => { d.description = desc.value; draw(); });
  const setColor = (c, fromHex) => { d.color = c; picker.value = c || o.def.color; if (!fromHex) hex.value = c; draw(); };
  picker.addEventListener('input', () => setColor(picker.value));
  hex.addEventListener('input', () => {
    const v = hex.value.trim();
    if (!v) return setColor('', true);
    if (/^#?[0-9a-f]{6}$/i.test(v)) setColor(`#${v.replace('#', '').toLowerCase()}`, true);
  });
  const setImage = (v) => { d.image = v; d.dirty = true; draw(); };
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try { setImage(await fileToEmbedImage(f)); toast('Image ready — press Save'); } catch (err) { toast(err.message, 'error'); }
  });
  url.addEventListener('change', () => {
    const v = url.value.trim();
    if (!v) return;
    if (!/^https:\/\//i.test(v)) { toast('The image link must start with https://', 'error'); return; }
    setImage(v); url.value = '';
  });
  draw();

  return card(o.heading, o.sub, el('div', { class: 'grid g2' },
    el('div', { class: 'emb-fields' },
      o.withSite ? el('label', {}, 'Site name (small text above the title)', site) : null,
      el('label', {}, 'Title', title),
      el('label', {}, 'Description', desc),
      el('div', {}, el('div', { class: 'muted', text: 'Colour of the stripe' }),
        el('div', { class: 'emb-row' }, picker, hex, btn('Default', async () => setColor(''), 'btn-ghost btn-sm'))),
      el('div', {}, el('div', { class: 'muted', text: 'Image' }),
        el('div', { class: 'emb-row' }, thumbPrev, btn('Upload image', async () => fileIn.click(), 'btn-ghost btn-sm'),
          btn('Remove', async () => setImage(''), 'btn-ghost btn-sm'), fileIn),
        url),
      el('div', { class: 'actions' }, btn('Save', async () => {
        const body = { siteName: d.siteName, title: d.title, description: d.description, color: d.color };
        if (d.dirty) body.image = d.image;
        await o.save(body);
        d.dirty = false;
      }, 'btn-primary btn-sm'))),
    el('div', {}, el('div', { class: 'muted', text: 'Preview' }), prev)));
}

/* ============================ CSV EXPORT ================================ */
function csvCell(v) {
  v = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function exportCsv(name, cols, rows) {
  const out = [cols.map((c) => csvCell(c.label)).join(',')];
  rows.forEach((r) => out.push(cols.map((c) => csvCell(c.get(r))).join(',')));
  download(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, out.join('\n'));
}
function csvBtn(name, cols, getRows) {
  return btn('Export CSV', async () => {
    const rows = getRows();
    if (!rows.length) throw new Error('Nothing to export');
    exportCsv(name, cols, rows);
    toast(`${num(rows.length)} rows exported`);
  });
}
const alink = (href, text, cls) => el('a', { href, class: cls || '', text });
const crumb = (href, text) => el('div', { class: 'crumbs' }, alink(href, text));
const fdate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
function kv(rows) {
  return el('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v == null || v === '' ? el('span', { class: 'muted', text: '—' }) : v)]));
}

/* ============================ GLOBAL SEARCH ============================= */
function initSearch() {
  const input = $('#search');
  const box = $('#search-res');
  let timer = 0;
  let seq = 0;
  const close = () => { box.classList.add('hidden'); box.replaceChildren(); };
  const item = (href, main, sub, extra) => el('a', {
    class: 'sr-item', href,
    onclick: () => { close(); input.value = ''; if (extra) extra(); },
  }, el('span', { text: main }), sub ? el('small', { text: sub }) : null);
  const group = (label, items) => (items.length ? el('div', { class: 'sr-group' }, el('div', { class: 'sr-h', text: label }), items) : null);

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await api(`/admin/search?q=${encodeURIComponent(q)}`, { quiet: true });
        if (mine !== seq) return;
        const parts = [
          group('Accounts', r.users.map((u) => item(`#/user/${u.id}`, u.username, u.role === 'admin' ? 'admin' : u.reseller ? 'premium' : 'booster'))),
          group('Redeem pages', r.pages.map((u) => item(`#/user/${u.id}`, `/r/${u.slug}`, u.username))),
          group('Keys', r.keys.map((k) => item('#/keys', k.code, `${k.boosts} boosts · ${k.redeemed ? 'redeemed' : 'unused'}${k.owner ? ` · ${k.owner}` : ''}`, () => {
            S.keys.q = k.code.toLowerCase(); if (location.hash === '#/keys') route();
          }))),
          group('Jobs', r.jobs.map((j) => item(`#/job/${j.id}`, j.invite || j.id.slice(0, 8), `${j.mode} · ${j.status}`))),
        ].filter(Boolean);
        box.replaceChildren(...(parts.length ? parts : [el('div', { class: 'sr-none', text: 'Nothing found' })]));
        box.classList.remove('hidden');
      } catch { /* a failed lookup just shows nothing */ }
    }, 250);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); input.blur(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('#search-wrap')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && S.token) { e.preventDefault(); input.focus(); }
  });
}
initSearch();

/* ============================ ACCOUNT SHEET ============================= */
async function vUser(root) {
  const d = await api(`/admin/users/${encodeURIComponent(S.param)}`);
  const p = d.profile;
  const st = d.stats;
  const reload = () => paint(VIEWS.find((v) => v.id === 'user'), false);
  const isAdmin = p.role === 'admin';
  $('#view-title').textContent = p.username;
  document.title = `${p.username} · Ninja Boost admin`;

  root.append(
    crumb(p.reseller ? '#/resellers' : '#/users', p.reseller ? '← Premium' : '← Accounts'),
    card(p.username, `Joined ${fdate(p.createdAt)} · ID ${p.id}`, el('div', { class: 'pills' },
      el('span', { class: `pill ${isAdmin ? 'brand' : ''}`, text: p.role }),
      p.reseller ? el('span', { class: 'pill ok', text: 'premium' }) : null,
      p.disabled ? el('span', { class: 'pill bad', text: 'suspended' }) : null,
      p.sellauth ? el('span', { class: 'pill ok', text: 'SellAuth' }) : null,
      p.apiKey ? el('span', { class: 'pill brand', text: `API ${p.apiKey.slice(4, 10)}…` }) : null)),
    el('div', { class: 'grid g4' },
      kpi('Wallet balance', usd(p.balance), p.reseller && p.boostPrice > 0 ? `${usd(p.boostPrice)} billed per boost` : 'USD'),
      kpi('Jobs', num(st.jobs), `${num(st.boosts)} boosts delivered`),
      kpi('Failed jobs', num(st.failed), st.jobs ? `${Math.round((st.failed / st.jobs) * 100)}% of their jobs` : 'no job yet', st.failed ? 'warn' : ''),
      kpi('Deposits', usd(st.depositsUsd), 'completed, last 30 listed')),
    p.reseller ? el('div', { class: 'grid g4' },
      kpi('Stock tokens', num(st.stockUnused), `${num(st.stockUsed)} already used`),
      kpi('Keys', num(st.keysUnused), `${num(st.keysTotal)} generated in total`),
      kpi('Price / boost', p.boostPrice > 0 ? usd(p.boostPrice) : 'Free', p.boostPrice > 0 ? 'taken from their wallet' : 'no wallet charge'),
      kpi('Redeem page', p.page.slug ? `/r/${p.page.slug}` : 'Not set', p.page.slug ? 'live' : 'they have not chosen a name yet')) : null);

  /* wallet & access */
  const amount = el('input', { type: 'number', step: '0.01', placeholder: '10.00 or -5.00', 'aria-label': 'Amount' });
  const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+ characters)', 'aria-label': 'New password' });
  const price = el('input', { type: 'number', step: '0.001', min: 0, max: 100, value: p.boostPrice, 'aria-label': 'Price per boost' });
  const note = el('textarea', { maxlength: 1000, placeholder: 'Private note about this account — only admins see it.', 'aria-label': 'Admin note', style: 'min-height:84px;font-family:var(--body);font-size:13.5px' });
  note.value = p.note;

  root.append(el('div', { class: 'grid g2' },
    card('Wallet & access', isAdmin ? 'This is an administrator account.' : 'Money, password and sign-in for this account.', el('div', { style: 'display:grid;gap:14px' },
      el('div', { class: 'row' }, el('label', {}, 'Add / remove funds (USD)', amount), btn('Apply', async () => {
        const r = await api(`/admin/users/${p.id}/balance`, { method: 'PATCH', body: { amount: Number(amount.value) } }); toast(r.message); await reload();
      }, 'btn-primary')),
      isAdmin ? null : el('div', { class: 'row' }, el('label', {}, 'Set a new password', pass), btn('Change', async () => {
        if (!confirm(`Change the password of ${p.username}? They will need the new one to sign in.`)) return;
        const r = await api(`/admin/users/${p.id}/password`, { method: 'PATCH', body: { password: pass.value } }); pass.value = ''; toast(r.message);
      })),
      isAdmin ? null : el('div', { class: 'actions' },
        btn(p.disabled ? 'Reactivate account' : 'Suspend account', async () => {
          if (!p.disabled && !confirm(`Suspend ${p.username}? They are signed out and can no longer sign in.`)) return;
          const r = await api(`/admin/users/${p.id}/disabled`, { method: 'PATCH', body: { disabled: !p.disabled } }); toast(r.message); await reload();
        }, p.disabled ? 'btn-primary btn-sm' : 'btn-danger btn-sm'),
        btn('Delete account', async () => {
          if (!confirm(`Delete ${p.username}? Their balance is lost.`)) return;
          await api(`/admin/users/${p.id}`, { method: 'DELETE' }); toast('Account deleted'); location.hash = '#/users';
        }, 'btn-danger btn-sm')),
      !isAdmin && p.reseller ? el('p', { class: 'muted', text: 'Suspending only blocks sign-in. To also stop their keys and redeem page, disable premium access.' }) : null)),
    card(isAdmin ? 'Admin' : 'Premium access', isAdmin ? 'Admin accounts cannot be premium accounts.' : 'Own stock, keys, API and redeem page.', isAdmin ? el('p', { class: 'muted', text: 'Change the admin login in Settings.' }) : el('div', { style: 'display:grid;gap:14px' },
      el('div', { class: 'row' }, el('label', {}, 'Price per boost (USD)', price), btn('Save price', async () => {
        const r = await api(`/admin/users/${p.id}/reseller`, { method: 'PATCH', body: { boostPrice: Number(price.value || 0) } }); toast(r.message); await reload();
      })),
      el('div', { class: 'actions' },
        btn(p.reseller ? 'Disable premium access' : 'Make premium', async () => {
          if (p.reseller && !confirm(`Remove premium access from ${p.username}? Their keys stop working until you enable them again.`)) return;
          const r = await api(`/admin/users/${p.id}/reseller`, { method: 'PATCH', body: { enabled: !p.reseller } }); toast(r.message); await reload();
        }, p.reseller ? 'btn-danger btn-sm' : 'btn-primary btn-sm'),
        p.apiKey ? btn('Revoke API key', async () => {
          if (!confirm(`Revoke the API key of ${p.username}?`)) return;
          const r = await api(`/admin/resellers/${p.id}/revoke-api`, { method: 'POST' }); toast(r.message); await reload();
        }, 'btn-ghost btn-sm') : null)))),
  card('Private note', 'Only visible here, in the admin panel.', el('div', { style: 'display:grid;gap:10px' }, note,
    el('div', { class: 'actions' }, btn('Save note', async () => {
      const r = await api(`/admin/users/${p.id}/note`, { method: 'PATCH', body: { note: note.value } }); toast(r.message);
    }, 'btn-primary btn-sm')))));

  if (p.reseller) root.append(...resellerBlocks(p, d, reload));

  root.append(
    card('Jobs', `Latest ${num(d.jobs.length)} — as booster${p.reseller ? ' and as the premium account whose keys were used' : ''}`, table(
      [{ label: 'When' }, { label: 'Type' }, { label: 'Key' }, { label: 'Server' }, { label: 'Boosts', num: true }, { label: 'Tokens', num: true, hide: true }, { label: 'Cost', num: true, hide: true }, { label: 'Status' }, { label: '' }],
      d.jobs.map((j) => el('tr', {},
        el('td', { text: ago(j.createdAt), title: fdate(j.createdAt) }),
        el('td', {}, el('span', { class: `pill ${j.mode === 'byot' ? '' : 'brand'}`, text: j.mode })),
        el('td', { class: 'mono', text: j.key || '—' }),
        el('td', { class: 'mono', text: j.invite || '—' }),
        el('td', { class: 'num', text: `${j.delivered}/${j.requested}` }),
        el('td', { class: 'num', text: num(j.tokens) }),
        el('td', { class: 'num mono', text: j.cost ? usd(j.cost) : '—' }),
        el('td', {}, pillFor(j.status)),
        el('td', { class: 'act' }, alink(`#/job/${j.id}`, 'Details')))),
      'No job yet.')),
    card('Wallet deposits', 'Latest 30', table(
      [{ label: 'When' }, { label: 'Amount', num: true }, { label: 'Received', num: true }, { label: 'Status' }, { label: 'Transaction' }],
      d.deposits.map((x) => el('tr', {},
        el('td', { text: ago(x.createdAt), title: fdate(x.createdAt) }),
        el('td', { class: 'num mono', text: usd(x.usd) }),
        el('td', { class: 'num mono', text: x.received ? `${x.received} ${x.currency}` : '—' }),
        el('td', {}, pillFor(x.status)),
        el('td', { class: 'mono muted', text: x.tx ? `${x.tx.slice(0, 14)}…` : '—' }))),
      'No deposit.')));
}

// Reseller-only sections: the redeem page, keys, SellAuth deliveries.
function resellerBlocks(p, d, reload) {
  const pg = p.page;
  let color = pg.color;
  const slug = el('input', { type: 'text', maxlength: 32, value: pg.slug, placeholder: 'my-shop', 'aria-label': 'Page name' });
  const title = el('input', { type: 'text', maxlength: 40, value: pg.title, placeholder: 'Big heading', 'aria-label': 'Title' });
  const brand = el('input', { type: 'text', maxlength: 30, value: pg.brand, placeholder: 'Name next to the icon', 'aria-label': 'Header name' });
  const support = el('input', { type: 'url', value: pg.supportUrl, placeholder: 'https://discord.gg/…', 'aria-label': 'Support link' });
  const picker = el('input', { type: 'color', value: pg.color || '#ff2d3f', 'aria-label': 'Page colour', style: 'height:38px;padding:3px;cursor:pointer' });
  const colorTxt = el('span', { class: 'mono muted', text: pg.color || 'default red' });
  picker.addEventListener('input', () => { color = picker.value; colorTxt.textContent = color; });

  const pageUrl = pg.slug ? `${location.origin}/r/${pg.slug}` : '';
  const pageCard = card('Redeem page', pg.slug ? 'Standalone page — no login, only this premium account’s keys.' : 'No page yet — set a name to publish one.', el('div', { style: 'display:grid;gap:14px' },
    pageUrl ? el('div', { class: 'actions' }, el('span', { class: 'mono', text: pageUrl }),
      btn('Copy', () => copy(pageUrl, 'Link copied')), el('a', { class: 'btn btn-ghost btn-sm', href: `/r/${encodeURIComponent(pg.slug)}`, target: '_blank', rel: 'noopener', text: 'Open page' })) : null,
    el('div', { class: 'grid g2' },
      el('label', {}, 'Page name', slug), el('label', {}, 'Title (big heading)', title),
      el('label', {}, 'Name (top left)', brand), el('label', {}, 'Support link', support)),
    el('div', { class: 'row' },
      el('label', { style: 'flex:0 0 120px' }, 'Colour', picker), el('div', { style: 'flex:1 1 140px;align-self:center' }, colorTxt),
      pg.icon ? el('img', { src: pg.icon, alt: 'Current icon', class: 'icon-prev' }) : el('span', { class: 'muted', text: 'default icon' })),
    el('div', { class: 'actions' },
      btn('Save page', async () => {
        const r = await api(`/admin/users/${p.id}/page`, { method: 'PATCH', body: { slug: slug.value, title: title.value, brand: brand.value, supportUrl: support.value, color } }); toast(r.message); await reload();
      }, 'btn-primary btn-sm'),
      btn('Default colour', async () => {
        const r = await api(`/admin/users/${p.id}/page`, { method: 'PATCH', body: { color: '' } }); toast(r.message); await reload();
      }),
      pg.hasIcon ? btn('Remove icon', async () => {
        const r = await api(`/admin/users/${p.id}/page`, { method: 'PATCH', body: { clearIcon: true } }); toast(r.message); await reload();
      }) : null,
      pg.slug ? btn('Unpublish page', async () => {
        if (!confirm(`Unpublish the redeem page of ${p.username}? Their link will stop working.`)) return;
        const r = await api(`/admin/users/${p.id}/page`, { method: 'PATCH', body: { slug: '' } }); toast(r.message); await reload();
      }, 'btn-danger btn-sm') : null)));

  const count = el('input', { type: 'number', min: 1, max: 200, value: 10, 'aria-label': 'Number of keys' });
  const boosts = el('input', { type: 'number', min: 1, max: 1000, value: 14, 'aria-label': 'Boosts per key' });
  const knote = el('input', { type: 'text', maxlength: 120, placeholder: 'optional', 'aria-label': 'Note' });
  const made = el('textarea', { readonly: true, class: 'hidden', 'aria-label': 'New keys' });
  const keyRows = d.keys;
  const keysCard = card('Keys', `${num(d.stats.keysUnused)} unused of ${num(d.stats.keysTotal)} · newest 300 listed`, el('div', { style: 'display:grid;gap:14px' },
    el('div', { class: 'row' }, el('label', {}, 'How many', count), el('label', {}, 'Boosts per key', boosts), el('label', { style: 'flex:2 1 160px' }, 'Note', knote),
      btn('Add keys to this premium account', async () => {
        const r = await api(`/admin/users/${p.id}/keys`, { method: 'POST', body: { count: Number(count.value), boostsPerKey: Number(boosts.value), note: knote.value } });
        toast(r.message); made.value = r.codes.join('\n'); made.classList.remove('hidden'); made.style.minHeight = '120px';
      }, 'btn-primary')),
    made,
    table([{ label: 'Key' }, { label: 'Boosts', num: true }, { label: 'Delivered', num: true }, { label: 'Status' }, { label: 'Used on' }, { label: 'Source', hide: true }, { label: 'Created', hide: true }, { label: '' }],
      keyRows.map((k) => el('tr', {},
        el('td', { class: 'mono', text: k.code }),
        el('td', { class: 'num', text: num(k.boosts) }),
        el('td', { class: 'num', text: num(k.delivered) }),
        el('td', {}, pillFor(k.redeemed ? 'redeemed' : 'unused')),
        el('td', { class: 'mono muted', text: k.invite || '—' }),
        el('td', { class: 'muted', text: k.note ? `${k.source} · ${k.note}` : k.source }),
        el('td', { class: 'muted', text: ago(k.createdAt), title: fdate(k.createdAt) }),
        el('td', { class: 'act' }, iconBtn('copy', 'Copy key', () => copy(k.code, 'Key copied'))))),
      'This premium account has no key yet.'),
    el('div', { class: 'actions' },
      csvBtn(`keys-${p.username}`, [
        { label: 'Key', get: (k) => k.code }, { label: 'Boosts', get: (k) => k.boosts }, { label: 'Delivered', get: (k) => k.delivered },
        { label: 'Redeemed', get: (k) => (k.redeemed ? 'yes' : 'no') }, { label: 'Server', get: (k) => k.invite }, { label: 'Created', get: (k) => k.createdAt },
      ], () => keyRows),
      btn('Delete unused keys', async () => {
        if (!confirm(`Delete every UNUSED key of ${p.username}?`)) return;
        const r = await api(`/admin/users/${p.id}/keys?scope=unused`, { method: 'DELETE' }); toast(r.message); await reload();
      }, 'btn-danger btn-sm'),
      btn('Delete all keys', async () => {
        if (!confirm(`Delete ALL keys of ${p.username}, including redeemed ones? This cannot be undone.`)) return;
        const r = await api(`/admin/users/${p.id}/keys?scope=all`, { method: 'DELETE' }); toast(r.message); await reload();
      }, 'btn-danger btn-sm'))));

  const sales = d.deliveries.length ? card('SellAuth deliveries', 'Latest 30', table(
    [{ label: 'When' }, { label: 'Boosts', num: true }, { label: 'Status' }],
    d.deliveries.map((x) => el('tr', {}, el('td', { text: ago(x.createdAt), title: fdate(x.createdAt) }), el('td', { class: 'num', text: num(x.boosts) }), el('td', {}, pillFor(x.status)))), 'None.')) : null;
  const embedCard = embedEditor({
    heading: 'Link embed — redeem page', sub: 'The card shown when this premium account’s page link is pasted in Discord, Telegram, X…',
    withSite: false,
    values: { title: pg.embedTitle, description: pg.embedDesc, color: pg.embedColor, image: pg.embedImage },
    def: {
      siteName: pg.brand || 'Ninja Boost', title: pg.title || pg.brand || 'Ninja Boost',
      description: `Redeem your key on ${pg.brand || 'Ninja Boost'} and boost your server in seconds.`,
      color: pg.color || '#ff2d3f', thumb: pg.icon || '/logo.png',
    },
    save: async (b) => {
      const body = { embedTitle: b.title, embedDesc: b.description, embedColor: b.color };
      if (b.image !== undefined) body.embedImage = b.image;
      const r = await api(`/admin/users/${p.id}/page`, { method: 'PATCH', body });
      toast(r.message);
    },
  });
  return [pageCard, embedCard, keysCard, sales];
}

/* ============================== JOB DETAIL ============================== */
async function vJob(root) {
  const d = await api(`/admin/jobs/${encodeURIComponent(S.param)}`);
  const j = d.job;
  $('#view-title').textContent = `Job ${j.id.slice(0, 8)}`;
  document.title = `Job ${j.id.slice(0, 8)} · Ninja Boost admin`;
  const who = (name, id) => (name && id ? alink(`#/user/${id}`, name) : name || null);
  root.append(
    crumb('#/jobs', '← Jobs'),
    el('div', { class: 'grid g4' },
      kpi('Status', j.status, j.retries ? `retried ${j.retries}×` : 'first attempt'),
      kpi('Boosts', `${num(j.delivered)}/${num(j.requested)}`, j.keyBoosts ? `key worth ${num(j.keyBoosts)}` : j.mode),
      kpi('Tokens used', num(j.tokens), `${d.items.length} tracked · ${num(d.cachedItems)} cached`),
      kpi('Cost', j.cost ? usd(j.cost) : '—', j.owner ? `billed to ${j.owner}` : 'platform')),
    card('Details', j.id, kv([
      ['Type', el('span', { class: `pill ${j.mode === 'byot' ? '' : 'brand'}`, text: j.mode })],
      ['Status', pillFor(j.status)],
      ['Premium / owner', who(j.owner, j.ownerId)],
      ['Booster account', who(j.user, j.userId)],
      ['Key', j.key ? el('span', { class: 'mono', text: j.key }) : null],
      ['Server invite', j.invite ? el('span', { class: 'mono', text: j.invite }) : null],
      ['Provider job id', j.provider ? el('span', { class: 'mono', text: j.provider }) : null],
      ['Auto-retry', j.autoRetry ? 'on' : 'off'],
      ['Created', fdate(j.createdAt)], ['Last update', fdate(j.updatedAt)], ['Last progress', fdate(j.lastProgressAt)],
    ])),
    card('Tokens', 'Tokens are masked.', table(
      [{ label: '#', num: true }, { label: 'Token' }, { label: 'Status' }, { label: 'Attempts', num: true }, { label: 'Started' }, { label: 'Updated' }],
      d.items.map((t, i) => el('tr', {},
        el('td', { class: 'num', text: i + 1 }), el('td', { class: 'mono', text: t.token }), el('td', {}, pillFor(t.status)),
        el('td', { class: 'num', text: t.attempts }), el('td', { class: 'muted', text: t.startedAt ? ago(t.startedAt) : '—' }), el('td', { class: 'muted', text: ago(t.updatedAt) }))),
      'No token is tracked for this job.')));
}

/* ============================== DEPOSITS ================================ */
async function vDeposits(root) {
  const { deposits, totals } = await api('/admin/deposits');
  let f = 'all';
  const holder = el('div');
  const draw = () => {
    const list = deposits.filter((x) => f === 'all' || x.status === f);
    holder.replaceChildren(table(
      [{ label: 'When' }, { label: 'Account' }, { label: 'Amount', num: true }, { label: 'Received', num: true }, { label: 'Status' }, { label: 'Transaction' }],
      list.map((x) => el('tr', {},
        el('td', { text: ago(x.createdAt), title: fdate(x.createdAt) }),
        el('td', {}, x.userId ? alink(`#/user/${x.userId}`, x.user) : x.user),
        el('td', { class: 'num mono', text: usd(x.usd) }),
        el('td', { class: 'num mono', text: x.received ? `${x.received} ${x.currency}` : '—' }),
        el('td', {}, pillFor(x.status)),
        el('td', { class: 'mono muted', title: x.tx, text: x.tx ? `${x.tx.slice(0, 16)}…` : '—' }))),
      'No deposit.'));
  };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter deposits' },
    [['all', 'All'], ['completed', 'Completed'], ['pending', 'Pending'], ['failed', 'Failed']].map(([id, label]) =>
      el('button', { type: 'button', 'aria-pressed': String(f === id), text: label, onclick: (e) => {
        f = id; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); draw();
      } })));
  draw();
  root.append(
    el('div', { class: 'grid g4' },
      kpi('Received', usd(totals.completedUsd), `${num(totals.completed)} completed top-ups`),
      kpi('Pending', num(totals.pending), 'waiting for payment', totals.pending ? 'warn' : ''),
      kpi('Failed', num(totals.failed), 'expired or rejected', totals.failed ? 'bad' : ''),
      kpi('Listed', num(deposits.length), 'latest 300 shown')),
    card('Wallet top-ups', 'Every crypto deposit made by customers', holder, [seg, csvBtn('deposits', [
      { label: 'Created', get: (x) => x.createdAt }, { label: 'Account', get: (x) => x.user }, { label: 'USD', get: (x) => x.usd },
      { label: 'Received', get: (x) => x.received }, { label: 'Currency', get: (x) => x.currency }, { label: 'Status', get: (x) => x.status }, { label: 'Tx', get: (x) => x.tx },
    ], () => deposits)]));
}

/* ============================== ACTIVITY ================================ */
function humanAction(method, path) {
  const rules = [
    [/^\/users\/[^/]+\/balance$/, 'Changed a wallet balance'], [/^\/users\/[^/]+\/password$/, 'Reset a password'],
    [/^\/users\/[^/]+\/disabled$/, 'Suspended / reactivated an account'], [/^\/users\/[^/]+\/reseller$/, 'Changed premium access or price'],
    [/^\/users\/[^/]+\/page$/, 'Edited a redeem page'], [/^\/users\/[^/]+\/keys$/, method === 'POST' ? 'Added keys to a premium account' : 'Deleted a premium account’s keys'],
    [/^\/users\/[^/]+\/note$/, 'Edited a private note'], [/^\/users\/[^/]+$/, 'Deleted an account'],
    [/^\/keys/, method === 'POST' ? 'Generated keys' : 'Deleted keys'], [/^\/tokens/, method === 'POST' ? 'Added or checked tokens' : 'Changed the stock'],
    [/^\/settings/, 'Changed settings'], [/^\/sellauth/, 'Changed SellAuth'], [/^\/resellers\/[^/]+\/revoke-api/, 'Revoked an API key'], [/^\/credentials/, 'Changed the admin login'],
  ];
  const hit = rules.find(([re]) => re.test(path));
  return hit ? hit[1] : `${method} ${path}`;
}
async function vActivity(root) {
  const r = await api('/admin/audit?limit=300');
  if (r.missing) {
    root.append(card('Activity log', 'Who did what in this panel', el('div', { class: 'note warn', text: `${r.hint} The log starts recording as soon as it has run.` })));
    return;
  }
  root.append(card('Activity log', `Latest ${num(r.entries.length)} changes made from this panel`, table(
    [{ label: 'When' }, { label: 'Admin' }, { label: 'Action' }, { label: 'Result' }, { label: 'Details' }],
    r.entries.map((a) => el('tr', {},
      el('td', { text: ago(a.at), title: fdate(a.at) }), el('td', { text: a.admin }),
      el('td', {}, el('div', { text: humanAction(a.method, a.path) }), el('small', { class: 'mono muted', text: `${a.method} ${a.path}` })),
      el('td', {}, el('span', { class: `pill ${a.status < 400 ? 'ok' : 'bad'}`, text: a.status < 400 ? 'done' : `failed ${a.status}` })),
      el('td', { class: 'muted', text: a.summary || '—' }))),
    'Nothing recorded yet — changes you make from now on appear here.'), csvBtn('activity', [
    { label: 'When', get: (a) => a.at }, { label: 'Admin', get: (a) => a.admin }, { label: 'Method', get: (a) => a.method },
    { label: 'Path', get: (a) => a.path }, { label: 'Status', get: (a) => a.status }, { label: 'Details', get: (a) => a.summary },
  ], () => r.entries)));
}

/* =============================== SYSTEM ================================= */
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
async function vSystem(root) {
  const s = await api('/admin/system');
  const missing = s.migrations.filter((m) => !m.ok);
  const cfgMissing = s.config.filter((c) => !c.ok && !/optional/i.test(c.note));
  root.append(
    el('div', { class: 'grid g4' },
      kpi('Server', s.runtime.node, `${s.runtime.platform}${s.runtime.serverless ? ' · serverless' : ''}`),
      kpi('Uptime', fmtUptime(s.runtime.uptimeSec), s.runtime.serverless ? 'serverless: restarts often' : 'since last restart'),
      kpi('Memory', `${s.runtime.memoryMb} MB`, 'resident'),
      kpi('Environment', s.runtime.env, s.runtime.maintenance ? 'MAINTENANCE MODE ON' : 'live', s.runtime.maintenance ? 'bad' : '')),
    missing.length ? el('div', { class: 'note warn', text: `Database not up to date. Run in the database SQL editor: ${[...new Set(missing.map((m) => m.file))].join(', ')}.` }) : el('div', { class: 'note', text: 'Database is up to date — every migration is applied.' }),
    cfgMissing.length ? el('div', { class: 'note warn', text: `Missing required settings: ${cfgMissing.map((c) => c.key).join(', ')}.` }) : null,
    el('div', { class: 'grid g2' },
      card('Configuration', 'Only whether each value is set — secrets are never shown', table(
        [{ label: 'Setting' }, { label: 'Status' }, { label: 'Used for' }],
        s.config.map((c) => el('tr', {}, el('td', { class: 'mono', text: c.key }), el('td', {}, el('span', { class: `pill ${c.ok ? 'ok' : /optional/i.test(c.note) ? 'warn' : 'bad'}`, text: c.ok ? 'set' : 'missing' })), el('td', { class: 'muted', text: c.note }))), 'None.')),
      card('Database migrations', 'Run the file in the database when one is missing', table(
        [{ label: 'Feature' }, { label: 'Status' }, { label: 'File' }],
        s.migrations.map((m) => el('tr', {}, el('td', { text: m.name }), el('td', {}, el('span', { class: `pill ${m.ok ? 'ok' : 'bad'}`, text: m.ok ? 'applied' : 'missing' })), el('td', { class: 'mono muted', text: m.file }))), 'None.'))),
    card('Database tables', 'Row counts', table(
      [{ label: 'Table' }, { label: 'Rows', num: true }],
      s.tables.map((t) => el('tr', {}, el('td', { class: 'mono', text: t.table }), el('td', { class: 'num', text: t.rows == null ? 'missing' : num(t.rows) }))), 'None.')));
}

/* ======================= OVERVIEW — extra insights ====================== */
function insightBlocks(ins) {
  return [
    el('div', { class: 'grid g4' },
      kpi('Accounts', num(ins.totals.users), `${num(ins.totals.resellers)} premium accounts`),
      kpi('Wallet balances', usd(ins.totals.wallets), 'owed to customers'),
      kpi('Deposits received', usd(ins.totals.depositsUsd), 'all time, completed'),
      kpi('Success rate · 30d', ins.success.rate == null ? '—' : `${ins.success.rate}%`, `${num(ins.success.completed)} ok · ${num(ins.success.failed)} failed`, ins.success.rate != null && ins.success.rate < 80 ? 'warn' : '')),
    el('div', { class: 'grid g2' },
      card('New accounts', 'Per day, last 14 days', barChart(ins.signups, 'count')),
      card('Deposits', 'USD received per day, last 14 days', barChart(ins.revenue, 'usd'))),
    el('div', { class: 'grid g2' },
      card('Top premium · 30 days', 'By boosts delivered', table(
        [{ label: 'Premium' }, { label: 'Boosts', num: true }, { label: 'Orders', num: true }],
        ins.topResellers.map((r) => el('tr', {}, el('td', {}, alink(`#/user/${r.id}`, r.username)), el('td', { class: 'num', text: num(r.boosts) }), el('td', { class: 'num', text: num(r.orders) }))),
        'No premium account activity yet.')),
      card('Most boosted servers · 30 days', 'Invite code · boosts delivered', table(
        [{ label: 'Server' }, { label: 'Boosts', num: true }, { label: 'Orders', num: true }],
        ins.topServers.map((r) => el('tr', {}, el('td', { class: 'mono', text: r.invite }), el('td', { class: 'num', text: num(r.boosts) }), el('td', { class: 'num', text: num(r.orders) }))),
        'No boost yet.'))),
  ];
}

/* ------------------------------ boot ----------------------------------- */
if (S.token && S.panel) { showShell(); route(); } else { showLogin(); }
