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
})();

const API = '/api';
const S = {
  token: sessionStorage.getItem('nb_admin_token'),
  panel: sessionStorage.getItem('nb_admin_panel'),
  view: 'overview',
  timer: null,
  keys: { list: [], filter: 'all', q: '' },
  navToken: 0,
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
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  keys: '<path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/>',
  stock: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  jobs: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  resellers: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  sellauth: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
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
    class: `pill ${({ completed: 'ok', delivered: 'ok', running: 'warn', pending: 'warn', partial: 'warn', valid: 'ok', locked: 'warn', invalid: 'bad', unused: 'ok', failed: 'bad', error: 'bad', used: '', redeemed: '' })[status] ?? ''}`,
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
      msg += ' — the database is missing the new tables/columns. Run db/migration_resellers.sql (or at least db/migration_sellauth_users.sql) in the Supabase SQL editor.';
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
  return el('div', { class: 'tbl-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.num ? 'num' : '', text: c.label })))),
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
  { id: 'jobs', title: 'Jobs', render: vJobs, live: true },
  { id: 'users', title: 'Users', render: vUsers },
  { id: 'resellers', title: 'Resellers', render: vResellers },
  { id: 'sellauth', title: 'SellAuth', render: vSellauth },
  { id: 'settings', title: 'Settings', render: vSettings },
];

function buildNav() {
  const nav = $('#nav');
  nav.replaceChildren(...VIEWS.map((v) =>
    el('a', { class: 'nav-link', href: `#/${v.id}`, 'aria-current': v.id === S.view ? 'page' : null }, icon(v.id), el('span', { text: v.title }))));
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
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
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
  const [st, jobs] = await Promise.all([api('/admin/stats'), api('/admin/jobs?limit=8')]);
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
    card('Resellers', 'Customers selling with their own stock and keys', el('div', { class: 'grid g4' },
      kpi('Resellers', num(st.resellers.total), 'accounts with reseller access'),
      kpi('Their tokens', num(st.resellers.stockUnused), 'unused, across all resellers'),
      kpi('Their keys', num(st.resellers.keysUnused), 'unused, across all resellers')),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/resellers', text: 'Manage resellers' })),
    card('Recent jobs', null, jobsTable(jobs.jobs), el('a', { class: 'btn btn-ghost btn-sm', href: '#/jobs', text: 'All jobs' })));
}

/* ============================== JOBS ==================================== */
function jobsTable(list) {
  return table(
    [{ label: 'When' }, { label: 'Type' }, { label: 'Owner' }, { label: 'Who' }, { label: 'Server' }, { label: 'Boosts', num: true }, { label: 'Tokens', num: true }, { label: 'Status' }],
    list.map((j) => el('tr', {},
      el('td', { text: ago(j.createdAt) }),
      el('td', {}, el('span', { class: `pill ${j.mode === 'byot' ? '' : 'brand'}`, text: j.mode })),
      el('td', {}, j.owner ? el('span', { class: 'pill brand', text: j.owner }) : el('span', { class: 'muted', text: 'you' })),
      el('td', { class: 'mono', text: j.key || j.user || '—' }),
      el('td', { class: 'mono', text: j.invite || '—' }),
      el('td', { class: 'num', text: `${j.delivered}/${j.requested}${j.mode === 'join' ? ' acc.' : ''}` }),
      el('td', { class: 'num', text: num(j.tokens) }),
      el('td', {}, pillFor(j.status), j.retries ? el('span', { class: 'muted', text: ` ×${j.retries + 1}` }) : null))),
    'No boost job yet.');
}
async function vJobs(root) {
  const { jobs } = await api('/admin/jobs?limit=150');
  root.append(card('Boost jobs', 'Latest 150 · refreshes every few seconds', jobsTable(jobs)));
}

/* ============================== KEYS ==================================== */
async function vKeys(root) {
  const { keys } = await api('/admin/keys');
  S.keys.list = keys;
  const boosts = el('input', { type: 'number', min: 1, value: 14, id: 'g-boosts' });
  const count = el('input', { type: 'number', min: 1, max: 500, value: 10, id: 'g-count' });
  const note = el('input', { type: 'text', maxlength: 120, placeholder: 'Optional — e.g. giveaway, reseller name' });
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
  const search = el('input', { type: 'search', placeholder: 'Search key, note or server…', style: 'max-width:240px', oninput: () => { S.keys.q = search.value.toLowerCase(); draw(); } });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filter keys' });
  [['all', 'All'], ['unused', 'Unused'], ['redeemed', 'Redeemed'], ['sellauth', 'SellAuth'], ['resellers', 'Resellers']].forEach(([id, label]) =>
    seg.append(el('button', { type: 'button', 'aria-pressed': String(S.keys.filter === id), onclick: () => { S.keys.filter = id; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === label))); draw(); }, text: label })));

  async function refreshKeys() {
    S.keys.list = (await api('/admin/keys')).keys;
    draw();
  }
  function draw() {
    const { list, filter, q } = S.keys;
    const shown = list.filter((k) =>
      (filter === 'all' || (filter === 'unused' && !k.redeemed) || (filter === 'redeemed' && k.redeemed) || (filter === 'sellauth' && k.source === 'sellauth') || (filter === 'resellers' && k.owner)) &&
      (!q || `${k.code} ${k.note} ${k.owner || ''} ${k.serverLink || ''} ${k.redeemedInvite || ''}`.toLowerCase().includes(q)));
    summary.textContent = `${num(shown.length)} shown · ${num(list.filter((k) => !k.redeemed).length)} unused of ${num(list.length)}`;
    const rows = shown.slice(0, 300).map((k) => el('tr', {},
      el('td', { class: 'mono', text: k.code }),
      el('td', { class: 'num', text: k.redeemed ? `${k.delivered}/${k.boosts}` : k.boosts }),
      el('td', {}, pillFor(k.redeemed ? 'redeemed' : 'unused')),
      el('td', {}, el('span', { class: `pill ${k.source === 'sellauth' ? 'brand' : ''}`, text: k.source })),
      el('td', {}, k.owner ? el('span', { class: 'pill brand', text: k.owner }) : el('span', { class: 'muted', text: 'you' })),
      el('td', { class: 'muted', text: k.redeemedInvite || k.serverLink || k.note || '—' }),
      el('td', { class: 'muted', text: ago(k.createdAt) }),
      el('td', { class: 'act' },
        iconBtn('copy', 'Copy key', () => copy(k.code, 'Key copied')),
        iconBtn('trash', 'Delete key', async () => { await api(`/admin/keys/${encodeURIComponent(k.code)}`, { method: 'DELETE' }); await refreshKeys(); }, 'del'))));
    listHost.replaceChildren(
      table([{ label: 'Key' }, { label: 'Boosts', num: true }, { label: 'Status' }, { label: 'Source' }, { label: 'Owner' }, { label: 'Note / server' }, { label: 'Created' }, { label: '' }], rows, 'No key matches.'),
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
// Platform stock only. Free (Salta7 "check"): up to 1,000 unused tokens a pass.
function checkerCard(unused, reload) {
  const host = el('div', { style: 'display:grid;gap:12px' });
  let purged = null;

  const start = el('button', {
    type: 'button', class: 'btn btn-primary btn-sm', text: 'Check my tokens', disabled: unused ? null : true,
    onclick: act(async () => { const r = await api('/admin/tokens/check', { method: 'POST' }); toast(r.message); purged = null; watch(r.check.id); }),
  });
  const dead = (label, n, statuses, id) => btn(`${label} (${num(n)})`, async () => {
    if (!n) throw new Error('Nothing to delete');
    if (!confirm(`${label}: ${n} token${n > 1 ? 's' : ''} will be removed from your stock.`)) return;
    const r = await api(`/admin/tokens/check/${id}/purge`, { method: 'POST', body: { statuses } });
    purged = { id, deleted: r.deleted }; toast(r.message); await reload();
  }, 'btn-danger btn-sm');

  async function showResults(id) {
    const r = await api(`/admin/tokens/check/${id}/results`), m = r.summary;
    host.replaceChildren(
      el('div', { class: 'grid g4' }, kpi('Valid', num(m.valid), `${num(m.nitro)} with Nitro`), kpi('Locked', num(m.locked), 'phone / email / re-verify'),
        kpi('Invalid', num(m.invalid), 'dead tokens', m.invalid ? 'bad' : ''), kpi('Free slots', num(m.freeSlots), 'on valid accounts')),
      el('div', { class: 'actions' }, dead('Delete invalid', m.invalid, ['invalid'], id), dead('Delete locked', m.locked, ['locked'], id),
        el('span', { class: 'muted', text: `checked ${ago(r.check.finishedAt || r.check.createdAt)}` })),
      table([{ label: 'Token' }, { label: 'Result' }, { label: 'Nitro' }, { label: 'Free slots', num: true }, { label: 'Lock' }, { label: 'Age' }],
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
    if (purged && purged.id === check.id) return host.replaceChildren(el('div', { class: 'note', text: `${purged.deleted} token${purged.deleted === 1 ? '' : 's'} deleted. Run a new check to refresh.` }));
    if (check.status === 'completed') showResults(check.id).catch(() => {});
  }).catch(() => {});

  return card('Token checker', 'Free. Tests your unused tokens (up to 1,000 per pass): valid, locked, Nitro, free boost slots.', host, start);
}

/* ============================== STOCK =================================== */
async function vStock(root) {
  const data = await api('/admin/tokens');
  const add = el('textarea', { rows: 6, placeholder: 'email:password:TOKEN\nTOKEN\nuser:pass:TOKEN' });
  const bulk = el('textarea', { rows: 8, placeholder: 'Press “Load unused” to edit the whole unused pool as text' });
  const reload = () => paint(VIEWS.find((v) => v.id === 'stock'), false);

  root.append(
    el('p', { class: 'muted', text: 'This is your own pool. Each reseller has a separate stock (see Resellers) — keys never draw from another owner’s tokens.' }),
    el('div', { class: 'grid g4' },
      kpi('Unused', num(data.unused), 'ready to be used for a boost'),
      kpi('Used', num(data.used), 'already spent on a boost'),
      kpi('Listed', num(data.total), 'newest 500 shown below')),
    checkerCard(data.unused, reload),
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
      [{ label: 'Token' }, { label: 'Status' }, { label: 'Server' }, { label: 'Added' }, { label: '' }],
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
  root.append(card('Accounts', `${num(users.length)} total · wallet balance of the booster accounts`, table(
    [{ label: 'Username' }, { label: 'Role' }, { label: 'Reseller' }, { label: 'Balance', num: true }, { label: 'Joined' }, { label: 'Add / remove funds' }, { label: '' }],
    users.map((u) => {
      const amount = el('input', { type: 'number', step: '0.01', placeholder: '10.00', 'aria-label': `Amount for ${u.username}` });
      return el('tr', {},
        el('td', { text: u.username }),
        el('td', {}, el('span', { class: `pill ${u.role === 'admin' ? 'brand' : ''}`, text: u.role })),
        el('td', {}, u.role === 'admin' ? el('span', { class: 'muted', text: '—' }) : u.reseller
          ? el('span', { class: 'inline-in' }, el('span', { class: 'pill ok', text: 'reseller' }), btn('Disable', async () => {
            if (!confirm(`Remove reseller access from ${u.username}? Their stock and keys are kept but stop working.`)) return;
            const d = await api(`/admin/users/${u.id}/reseller`, { method: 'PATCH', body: { enabled: false } }); toast(d.message); await reload();
          }))
          : btn('Make reseller', async () => {
            const d = await api(`/admin/users/${u.id}/reseller`, { method: 'PATCH', body: { enabled: true } }); toast(d.message); await reload();
          })),
        el('td', { class: 'num mono', text: usd(u.balance) }),
        el('td', { class: 'muted', text: ago(u.createdAt) }),
        el('td', {}, el('span', { class: 'inline-in' }, amount, btn('Apply', async () => {
          const d = await api(`/admin/users/${u.id}/balance`, { method: 'PATCH', body: { amount: Number(amount.value) } });
          toast(d.message); await reload();
        }))),
        el('td', { class: 'act' }, u.role === 'admin' ? null : iconBtn('trash', 'Delete account', async () => {
          if (!confirm(`Delete ${u.username}? Their balance is lost.`)) return;
          await api(`/admin/users/${u.id}`, { method: 'DELETE' }); await reload();
        }, 'del')));
    }), 'No account yet.')));
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
      kpi('Resellers', num(resellers.length), 'accounts with reseller access'),
      kpi('Their tokens', num(totals.stock), 'unused, all resellers'),
      kpi('Their keys', num(totals.keys), 'unused, all resellers'),
      kpi('Boosts delivered', num(totals.boosts), 'through resellers, all time')),
    card('Add a reseller', 'The customer registers on the customer panel first, then appears here.', el('div', { style: 'display:grid;gap:12px' },
      el('div', { class: 'row' },
        el('label', { style: 'flex:2 1 220px' }, 'Account', pick),
        el('label', {}, 'Price per boost (USD)', price),
        el('button', {
          type: 'button', class: 'btn btn-primary', text: 'Enable reseller',
          onclick: act(async () => {
            if (!pick.value) throw new Error('Choose an account');
            const d = await api(`/admin/users/${pick.value}/reseller`, { method: 'PATCH', body: { enabled: true, boostPrice: Number(price.value || 0) } });
            toast(d.message); await reload();
          }),
        })),
      el('p', { class: 'muted', text: 'They get Files (own stock), Keys, API and a Redeem Page of their own. The price is taken from their wallet for every boost actually delivered — leave 0 to let them sell for free, or top up their balance in Users.' }))),
    card('Resellers', 'Stock, keys and volume per reseller', table(
      [{ label: 'Reseller' }, { label: 'Stock', num: true }, { label: 'Keys', num: true }, { label: 'Boosts · joins', num: true }, { label: 'Sales', num: true }, { label: 'Balance', num: true }, { label: 'Price / boost' }, { label: 'Page' }, { label: 'API' }, { label: '' }],
      resellers.map((r) => {
        const p = el('input', { type: 'number', step: '0.001', min: 0, max: 100, value: r.boostPrice, 'aria-label': `Price per boost for ${r.username}` });
        return el('tr', {},
          el('td', {}, r.username, r.sellauth ? el('span', { class: 'pill ok', style: 'margin-left:8px', title: 'SellAuth dynamic delivery is set up', text: 'SellAuth' }) : null),
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
            btn('Disable', async () => {
              if (!confirm(`Remove reseller access from ${r.username}? Their keys stop working until you enable them again.`)) return;
              const d = await api(`/admin/users/${r.id}/reseller`, { method: 'PATCH', body: { enabled: false } }); toast(d.message); await reload();
            }, 'btn-danger btn-sm')));
      }),
      'No reseller yet — enable one above.')));
}

/* ============================= SELLAUTH ================================= */
async function vSellauth(root) {
  const [cfg, log] = await Promise.all([api('/admin/sellauth'), api('/admin/sellauth/deliveries')]);
  const reload = () => paint(VIEWS.find((v) => v.id === 'sellauth'), false);
  const url = `${location.origin}/api/sellauth/deliver`;

  const secret = el('input', { type: 'password', autocomplete: 'off', placeholder: cfg.secretSet ? '•••••••• (saved — type to replace)' : 'Paste your SellAuth webhook secret', disabled: cfg.secretFromEnv });
  const def = el('input', { type: 'number', min: 0, max: 1000, value: cfg.defaultBoosts || '', placeholder: 'None' });
  const field = el('input', { type: 'text', maxlength: 60, value: cfg.linkField || 'Server Link' });

  const connection = card('Connection', 'Give SellAuth this URL and this secret.', el('div', { style: 'display:grid;gap:14px' },
    el('label', {}, 'Webhook URL',
      el('div', { class: 'copybox' }, el('input', { type: 'text', readonly: true, value: url }), btn('Copy', () => copy(url, 'URL copied')))),
    el('div', { class: 'row' },
      el('label', { style: 'flex:2 1 260px' }, 'Webhook secret', secret),
      el('label', {}, 'Fallback boosts', def),
      el('label', {}, 'Custom field name', field),
      el('button', {
        type: 'button', class: 'btn btn-primary', text: 'Save',
        onclick: act(async () => {
          const body = { defaultBoosts: Number(def.value || 0), linkField: field.value.trim() };
          if (!cfg.secretFromEnv && secret.value.trim()) body.webhookSecret = secret.value.trim();
          const d = await api('/admin/sellauth', { method: 'PATCH', body });
          toast(d.message); await reload();
        }),
      })),
    el('div', { class: 'actions' },
      el('span', { class: `pill ${cfg.secretSet ? 'ok' : 'bad'}`, text: cfg.secretSet ? 'Secret configured' : 'No secret — deliveries are refused' }),
      cfg.secretFromEnv ? el('span', { class: 'muted', text: 'Set through SELLAUTH_WEBHOOK_SECRET' }) : null)));

  const guide = card('Set up a product', null, el('ol', { class: 'steps' },
    el('li', {}, el('span', {}, 'In SellAuth open the product → ', el('b', { text: 'Deliverables' }), ' → choose ', el('b', { text: 'Dynamic Delivery' }), '.')),
    el('li', {}, el('span', {}, 'Webhook URL: the one above. To fix the amount right in the URL add ', el('code', { text: '?boosts=14' }), ' (best when a product = one amount).')),
    el('li', {}, el('span', {}, 'Or link the product / variant ID below. Without either, the number in its name is used (“14 Boosts”), then the fallback amount.')),
    el('li', {}, el('span', {}, 'Add a ', el('b', { text: 'Custom Field' }), ' named ', el('code', { text: 'Server Link' }), ' (required) to the product: the buyer pastes their Discord invite there and it is saved with the key.')),
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
      el('td', { class: 'mono', text: d.key || '—' }),
      el('td', {}, d.serverLink ? el('span', { class: 'mono', text: d.serverLink }) : (d.status === 'delivered' ? el('span', { class: 'pill warn', text: 'no link' }) : '—')),
      el('td', {}, pillFor(d.status), d.status === 'error'
        ? el('div', { style: 'margin-top:4px' }, el('span', { class: 'muted', text: d.error }), ' ',
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Payload', onclick: () => detail.classList.toggle('hidden') }), detail)
        : null)));
  });
  const deliveries = card('Deliveries', 'Your own shop — latest 100 calls (resellers have their own log in their panel). A failed one shows the payload SellAuth sent, so you can see which ID to link.',
    table([{ label: 'When' }, { label: 'Invoice' }, { label: 'Product' }, { label: 'Boosts', num: true }, { label: 'Key' }, { label: 'Server' }, { label: 'Result' }], rows, 'No delivery yet — place a test order.'));

  root.append(el('div', { class: 'grid g-main' }, connection, guide), links, deliveries);
}

/* ============================= SETTINGS ================================= */
async function vSettings(root) {
  const s = await api('/admin/settings');
  const price = el('input', { type: 'number', step: '0.001', min: 0, value: s.captchaCost });
  const support = el('input', { type: 'url', placeholder: 'https://discord.gg/yourinvite', value: s.supportUrl || '' });
  const nu = el('input', { type: 'text', autocomplete: 'off', placeholder: 'New username' });
  const np = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (6+ characters)' });

  root.append(el('div', { class: 'grid g2' },
    card('Pricing', 'What a booster pays per solved captcha (BYOT mode).', el('div', { class: 'row' }, el('label', {}, 'USD per solve', price),
      btn('Save', async () => { await api('/admin/settings', { method: 'PATCH', body: { captchaCost: Number(price.value) } }); toast('Pricing saved'); }, 'btn-primary'))),
    card('Support link', 'Shown to a customer when some boosts could not be delivered.', el('div', { class: 'row' }, el('label', { style: 'flex:2 1 220px' }, 'URL', support),
      btn('Save', async () => { await api('/admin/settings', { method: 'PATCH', body: { supportUrl: support.value.trim() } }); toast('Support link saved'); }, 'btn-primary')))),
    card('Admin account', 'Replaces the current admin login. You stay signed in.', el('div', { class: 'row' }, el('label', {}, 'Username', nu), el('label', {}, 'Password', np),
      btn('Update account', async () => {
        if (!confirm('Replace the admin username and password?')) return;
        const d = await api('/admin/credentials', { method: 'PATCH', body: { username: nu.value.trim(), password: np.value } });
        setSession(d.token, d.panelToken); nu.value = np.value = ''; toast('Admin account updated');
      }, 'btn-primary'))),
    el('p', { class: 'muted', text: 'The panel password is set with the ADMIN_PANEL_PASSWORD environment variable.' }));
}

/* ------------------------------ boot ----------------------------------- */
if (S.token && S.panel) { showShell(); route(); } else { showLogin(); }
