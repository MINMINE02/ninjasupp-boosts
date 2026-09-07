'use strict';

/* =========================================================================
 * Ninja Boost - frontend controller
 *
 * THIS IS THE SOURCE. public/app.js is a generated, obfuscated build of this
 * file -- never edit public/app.js directly, it gets overwritten.
 * After changing this file, run `npm run build:js` to regenerate it.
 *
 * Views:
 *   #public-view  - anonymous "redeem key & boost" panel (default)
 *   #login-view   - login/register for BYOT
 *   #app-view     - logged-in BYOT boosting + admin
 * ========================================================================= */

const API = '/api';
const DEFAULT_CAPTCHA_COST = 0.015;
const DEFAULT_BOOSTS_PER_TOKEN = 2;

const state = {
  token: localStorage.getItem('db_token') || null,
  user: null,
  authMode: 'login',
  currentJobId: null,
  pollTimer: null,
  startedAt: null,
  quoteTimer: null,
  adminUnlocked: false,
  redeemJobId: null,
  redeemPollTimer: null,
  redeemStartedAt: null,
  topupDepositId: null,
  topupPollTimer: null,
  historyPollTimer: null,
  ltcRate: null,
  settings: {
    captchaCost: DEFAULT_CAPTCHA_COST,
    boostsPerToken: DEFAULT_BOOSTS_PER_TOKEN,
  },
};

/* ------------------------------ helpers -------------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Endpoint path fragments are kept base64-encoded at rest so a static read
// of this bundle (grep, view-source) doesn't hand over a plain-text list of
// every route -- decoded at call time, right where each one is used.
const d = (b64) => atob(b64);

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = {};
  try { data = await res.json(); } catch { /* empty */ }

  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, type = 'success') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('hidden'), 3200);
}

// Formats a USD amount WITHOUT forcing it to exactly 2 decimals — money here
// can be fractions of a cent (e.g. a $0.015 captcha charge), and rounding
// that to $0.02 both misrepresents the real price and hides real balance
// changes. Shows the exact value, trimmed of trailing zeros, with at least
// 2 decimal places for whole-cent amounts ($10 -> $10.00, $0.015 -> $0.015).
function fmtUSD(n) {
  n = Number(n || 0);
  let s = n.toFixed(4);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  const decimals = s.includes('.') ? s.split('.')[1].length : 0;
  if (decimals < 2) s = n.toFixed(2);
  return `$${s}`;
}

function parseTokens(text) {
  return (text || '').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
}

function renderStatusBox(prefix, { stateText, delivered, requested, tokensUsed, cost, startedAt }) {
  $(`#${prefix}-box`).classList.remove('hidden');
  const pct = requested > 0 ? Math.min(100, (delivered / requested) * 100) : 0;
  $(`#${prefix === 'status' ? 'progress-bar' : 'redeem-progress-bar'}`).style.width = `${pct}%`;

  const stateEl = $(`#${prefix === 'status' ? 'status-state' : 'redeem-status-state'}`);
  stateEl.textContent = stateText;
  stateEl.className = 'status-state';
  if (stateText.startsWith('Completed')) stateEl.classList.add('completed');
  if (stateText.startsWith('Failed')) stateEl.classList.add('failed');

  const detailId = prefix === 'status' ? 'status-detail' : 'redeem-status-detail';
  $(`#${detailId}`).textContent = `${delivered} / ${requested} boosts delivered`;

  const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
  const elapsedId = prefix === 'status' ? 'status-elapsed' : 'redeem-status-elapsed';
  $(`#${elapsedId}`).textContent = `Elapsed: ${elapsed}s`;

  if (prefix === 'status') {
    $('#status-tokens').textContent = `${tokensUsed} tokens used`;
    $('#status-cost').textContent = `Cost: ${fmtUSD(cost)}`;
  }
}

/* ------------------------------ views ---------------------------------- */
function showView(view) {
  $('#public-view').classList.toggle('hidden', view !== 'public');
  $('#login-view').classList.toggle('hidden', view !== 'login');
  $('#app-view').classList.toggle('hidden', view !== 'app');
  $('#redeem-result-view').classList.toggle('hidden', view !== 'redeem-result');
}

function showApp() {
  showView('app');
  $$('.admin-only').forEach((el) =>
    el.classList.toggle('hidden', state.user?.role !== 'admin')
  );
  $('#ab-username').textContent = state.user?.username || '—';
}

async function renderBalance() {
  try {
    const data = await api(d('L3dhbGxldA=='));
    if (data.ltcRate) state.ltcRate = Number(data.ltcRate);
    setWalletUI(data.balance);
    updateTopupPreview();
  } catch {
    const ab = $('#ab-balance');
    if (ab) ab.textContent = '—';
  }
}

function setWalletUI(balance) {
  const b = Number(balance || 0);
  const txt = fmtUSD(b);
  ['#ab-balance', '#wallet-balance', '#pf-balance'].forEach((sel) => {
    const el = $(sel);
    if (el) el.textContent = txt;
  });
  if (state.user) state.user.balance = b;
  // Keep the booster's cost/balance gate in sync with the wallet.
  if (typeof updateStartEnabled === 'function') updateStartEnabled();
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('db_token', token);
  showApp();
  // If the user came here via the Account button, land on the Account tab.
  if (state.postLoginTab) {
    const tab = state.postLoginTab;
    state.postLoginTab = null;
    document.querySelector(`.acc-btn[data-tab="${tab}"]`)?.click();
  }
}

function logout() {
  state.token = null;
  state.user = null;
  state.adminUnlocked = false;
  localStorage.removeItem('db_token');
  $('#admin-content').classList.add('hidden');
  $('#admin-lock').classList.add('centered');
  stopPolling();
  stopDepositPolling();
  stopHistoryPolling();
  showView('public');
  setPublicMode('stock');
}

/* ------------------------------ auth ----------------------------------- */
// Header button toggles between the Redeem panel and the BYOT booster.
// (In BYOT the fields are login-gated, so login happens on interaction.)
$('#show-login-btn').addEventListener('click', () => {
  setPublicMode(publicMode === 'stock' ? 'byot' : 'stock');
});
$('#back-public-btn').addEventListener('click', () => showView('public'));

// Account button: go to the account area (login first if needed).
function goToAccount() {
  if (state.token) {
    showApp();
    document.querySelector('.acc-btn[data-tab="deposit"]').click();
  } else {
    state.postLoginTab = 'deposit';
    showView('login');
  }
}
$('#account-btn').addEventListener('click', goToAccount);

$$('.auth-tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    state.authMode = tab.dataset.authTab;
    $$('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#auth-submit').textContent = state.authMode === 'login' ? 'Login' : 'Register';
    $('#auth-error').textContent = '';
  })
);

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  try {
    const data = await api(`${d('L2F1dGgv')}${state.authMode}`, {
      method: 'POST',
      body: { username, password },
    });
    setSession(data.token, data.user);
    renderBalance();
    loadSettings();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', logout);

/* ------------------------------ tabs ----------------------------------- */
$$('.acc-btn[data-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.acc-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'history') startHistoryPolling(); else stopHistoryPolling();
    if (tab === 'admin') enterAdmin();
    else if (tab === 'deposit') loadDeposit();
    else if (tab === 'profile') loadProfile();
  })
);

function loadDeposit() { renderBalance(); }
function loadHistory() { renderBalance(); loadBoostHistory(); loadDeposits(); }
// Keep the History tab live while it's open — the backend syncs any
// still-running job / still-pending deposit on every fetch, so re-polling
// here is what actually surfaces that progress without needing a manual
// tab switch away and back.
function startHistoryPolling() {
  stopHistoryPolling();
  loadHistory();
  state.historyPollTimer = setInterval(loadHistory, 4000);
}
function stopHistoryPolling() {
  if (state.historyPollTimer) clearInterval(state.historyPollTimer);
  state.historyPollTimer = null;
}
function loadProfile() {
  renderBalance();
  const u = state.user || {};
  $('#pf-username').textContent = u.username || '—';
  $('#pf-role').textContent = u.role || '—';
  $('#pf-created').textContent = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
  $('#pf-balance').textContent = fmtUSD(u.balance);
}

$$('.subtab').forEach((tab) =>
  tab.addEventListener('click', () => {
    const sub = tab.dataset.subtab;
    $$('.subtab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.subpanel').forEach((p) => p.classList.toggle('active', p.id === `sub-${sub}`));
  })
);

/* ------------------------------ settings ------------------------------- */
async function loadSettings() {
  try {
    const s = await api(d('L3NldHRpbmdz'));
    state.settings = {
      captchaCost: Number(s.captchaCost),
      boostsPerToken: Number(s.boostsPerToken) || DEFAULT_BOOSTS_PER_TOKEN,
    };
    applySettingsToUI();
  } catch { /* keep defaults */ }
}

function applySettingsToUI() {
  updateTokenCounter();
  // Recompute the cost strip now that the real price is known (tokens may
  // already be in the field before settings finished loading).
  updateStartEnabled();
}

// Public client config (e.g. the URL the logo links to).
async function loadConfig() {
  let logoUrl = '';
  try {
    const cfg = await api(d('L2NvbmZpZw=='));
    logoUrl = String(cfg.logoUrl || '');
    state.supportUrl = String(cfg.supportUrl || '');
  } catch { /* keep default */ }

  $$('.logo, .auth-logo').forEach((el) => {
    if (logoUrl) {
      el.setAttribute('href', logoUrl);
    } else {
      el.setAttribute('href', '#');
      el.addEventListener('click', (e) => e.preventDefault(), { once: false });
    }
  });
}

/* =======================================================================
 * PUBLIC: Boost panel (Our stock via key / Your own tokens via login)
 * ===================================================================== */
let publicMode = 'stock';

// Switch the public panel between the redeem (stock) and BYOT boosters. The
// header button is the toggle and its label always names the OTHER panel.
function setPublicMode(mode) {
  publicMode = mode;
  $('#pm-stock').classList.toggle('hidden', mode !== 'stock');
  $('#pm-byot').classList.toggle('hidden', mode !== 'byot');
  $('#feature-chips').classList.toggle('hidden', mode !== 'stock');
  const solve = $('#solve-note');
  solve.classList.toggle('hidden', mode !== 'byot');
  solve.textContent = `$${state.settings.captchaCost} each solve`;
  $('#p-start-label').textContent = mode === 'stock' ? 'Redeem Now' : 'Boost with my tokens';
  $('#brand-sub').textContent = mode === 'stock' ? 'Key Redeem Panel' : 'Discord Server Booster';
  $('#show-login-btn').textContent = mode === 'stock' ? 'Booster' : 'Redeem Panel';
  $('#redeem-message').textContent = '';
}

// In BYOT mode, every input is login-gated: if the user is not logged in,
// interacting with any field sends them to the login screen first.
function byotNeedsLogin() {
  if (publicMode === 'byot' && !state.token) {
    showView('login');
    return true;
  }
  return false;
}
['mousedown', 'focus'].forEach((ev) => {
  ['#redeem-invite', '#p-tokens', '#p-boosts'].forEach((sel) => {
    $(sel).addEventListener(ev, (e) => {
      if (byotNeedsLogin()) {
        e.preventDefault();
        if (e.target && typeof e.target.blur === 'function') e.target.blur();
      }
    });
  });
});

// Quantity field (public BYOT) — 0 means "use all tokens".
function clampBoosts(v) { return Math.max(0, Math.min(40, Number(v) || 0)); }
$('#p-boosts').addEventListener('input', () => {
  if ($('#p-boosts').value !== '') $('#p-boosts').value = clampBoosts($('#p-boosts').value);
});
$('#p-tokens').addEventListener('input', () => {
  const n = parseTokens($('#p-tokens').value).length;
  $('#p-token-counter').textContent = `${n} tokens loaded`;
});

// Wand button — paste tokens straight from the clipboard into the field.
$('#p-wand').addEventListener('click', async () => {
  if (byotNeedsLogin()) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const field = $('#p-tokens');
    field.value = field.value ? `${field.value.replace(/\s*$/, '')}\n${text.trim()}` : text.trim();
    field.dispatchEvent(new Event('input'));
    field.focus();
  } catch (_) { /* clipboard unavailable — ignore */ }
});

// Main action button — adapts to the selected mode.
$('#p-start').addEventListener('click', () => {
  if (publicMode === 'byot') {
    if (!state.token) { showView('login'); return; }
    // Already logged in — hand off to the full BYOT boost tab.
    showApp();
    document.querySelector('.acc-btn[data-tab="boost"]').click();
    return;
  }
  doRedeem();
});

async function doRedeem() {
  const msg = $('#redeem-message');
  msg.className = 'form-message';
  msg.textContent = '';
  const invite = $('#redeem-invite').value.trim();
  const key = $('#redeem-key').value.trim();

  if (!invite) { msg.classList.add('error'); msg.textContent = 'Enter an invite link'; return; }
  if (!key) { msg.classList.add('error'); msg.textContent = 'Enter your key'; return; }

  $('#p-start').disabled = true;
  try {
    const data = await api(d('L2Jvb3N0L3JlZGVlbQ=='), { method: 'POST', body: { invite, key } });
    state.redeemJobId = data.job.id;
    state.redeemStartedAt = Date.now();

    // Fill and redirect to the confirmation page.
    $('#rr-key').textContent = key;
    $('#rr-tokens').textContent = data.job.tokensUsed;
    renderRedeemResult({ status: 'running', delivered: data.keyDelivered, requested: data.keyTotal });
    setupSupportLink();
    // Preview which server the boost went to.
    state.rrInviteVal = invite;
    lookupInvite(invite, {
      box: 'rr-server', name: 'rr-ip-name', id: 'rr-ip-id', icon: 'rr-ip-icon',
      members: 'rr-ip-members', online: 'rr-ip-online', boosts: 'rr-ip-boosts',
      stateKey: 'rrInviteVal', timerKey: 'rrInviteTimer',
    });
    showView('redeem-result');
    startRedeemPolling();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = `${err.message}`;
  } finally {
    $('#p-start').disabled = false;
  }
}

// Renders the circular boost status + key info on the redeem confirmation
// page. `status` is one of 'running' | 'completed' | 'failed'. Once the key
// is fully redeemed (completed) the status ring is hidden — the Key
// Information panel's Boosts row already shows the done/total outcome.
function renderRedeemResult({ status, delivered, requested, retryCount }) {
  const statusSection = $('#rr-status-section');
  statusSection.classList.toggle('hidden', status === 'completed');

  const ring = $('#rr-ring-wrap');
  ring.className = `rr-ring-wrap ${status}`;
  $('#rr-icon-check').classList.toggle('hidden', status !== 'completed');
  $('#rr-icon-x').classList.toggle('hidden', status !== 'failed');
  $('#rr-ring-count').textContent = `${delivered}/${requested}`;

  const titles = {
    running: retryCount > 0 ? `Retrying tokens… (attempt ${retryCount + 1})` : 'Running boosts…',
    completed: 'Boost successful!',
    failed: 'Boost failed',
  };
  const st = $('#rr-state');
  st.textContent = titles[status] || titles.running;
  st.className = `rr-status-title ${status === 'running' ? '' : status}`;

  $('#rr-delivered').textContent = delivered;
  $('#rr-requested').textContent = requested;
  $('#rr-boosts').textContent = `${delivered}/${requested}`;

  $('#rr-support-note').classList.toggle('hidden', status !== 'failed');
  const supportLabel = $('#rr-support-label');
  if (supportLabel) {
    supportLabel.textContent = 'Contact owner on Telegram @boostredeem';
  }
}

function setupSupportLink() {
  const btn = $('#rr-support');
  if (state.supportUrl) { btn.href = state.supportUrl; btn.classList.remove('hidden'); }
  else { btn.classList.add('hidden'); }
}

$('#rr-back').addEventListener('click', () => {
  stopRedeemPolling();
  state.redeemJobId = null;
  $('#redeem-key').value = '';
  showView('public');
});

function startRedeemPolling() {
  stopRedeemPolling();
  redeemPollOnce();
  state.redeemPollTimer = setInterval(redeemPollOnce, 3000);
}
function stopRedeemPolling() {
  if (state.redeemPollTimer) clearInterval(state.redeemPollTimer);
  state.redeemPollTimer = null;
}
async function redeemPollOnce() {
  if (!state.redeemJobId) return;
  try {
    const { job, keyTotal, keyDelivered } = await api(`${d('L2Jvb3N0L3JlZGVlbS9zdGF0dXMv')}${state.redeemJobId}`);
    const status = job.status === 'completed' || job.status === 'failed' ? job.status : 'running';
    renderRedeemResult({
      status,
      delivered: keyDelivered ?? job.boostsDelivered,
      requested: keyTotal ?? job.boostsRequested,
      retryCount: job.retryCount || 0,
    });
    if (status === 'completed' || status === 'failed') {
      stopRedeemPolling();
      $('#p-start').disabled = false;
    }
  } catch { /* keep polling */ }
}

/* ---- Per-token live status list (BYOT) ------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// The credential the user pastes may be `email:pass:token` — the token is the
// last colon-separated segment, which is what Salta7 reports back.
function tokenTail(line) {
  const parts = String(line).split(':');
  return parts[parts.length - 1] || String(line);
}
// Mirrors the server's maskToken() exactly (reveals ~half + an ellipsis) so
// masked previews can be matched back to the user's full tokens below.
function maskTok(t) {
  t = String(t || '');
  if (!t) return '';
  const revealLen = Math.max(6, Math.ceil(t.length / 2));
  if (t.length <= revealLen) return t;
  return `${t.slice(0, revealLen)}…`;
}
// Map the server's masked per-token results back onto the user's full
// tokens, carrying along the boosts-delivered count and captcha flag.
function tokenStatuses(tokens, items) {
  const statuses = tokens.map(() => ({ status: 'waiting', boosts: 0, captcha: false }));
  const used = tokens.map(() => false);
  const masks = tokens.map((t) => maskTok(tokenTail(t)));
  const leftover = [];
  (items || []).forEach((it) => {
    const st = {
      status: it.ok === true ? 'joined' : it.ok === false ? 'failed' : 'waiting',
      boosts: Number(it.boosts) || 0,
      captcha: Boolean(it.captcha),
    };
    const idx = masks.findIndex((m, i) => !used[i] && m && m === it.token);
    if (idx === -1) { leftover.push(st); return; }
    used[idx] = true; statuses[idx] = st;
  });
  // Any results we couldn't match by mask fill the remaining rows in order.
  let li = 0;
  for (let i = 0; i < statuses.length && li < leftover.length; i += 1) {
    if (!used[i]) { statuses[i] = leftover[li]; used[i] = true; li += 1; }
  }
  return statuses;
}
// Renders one pills row (status badge + optional captcha/boosts pills), used
// by both the BYOT per-token list and the redeem accounts list.
function renderResultPills(st) {
  const spin = st.status === 'waiting' ? '<span class="ts-spin"></span>' : '';
  const label = st.status === 'joined' ? 'joined' : st.status === 'failed' ? 'failed' : 'waiting';
  let html = `<span class="ts-badge ${st.status}">${spin}${label}</span>`;
  if (st.status === 'joined') {
    if (st.captcha) html += '<span class="ts-pill captcha">captcha</span>';
    if (st.boosts > 0) html += `<span class="ts-pill boosts">+${st.boosts}</span>`;
  }
  return html;
}

function renderTokenStatus(items) {
  const tokens = state.boostTokens || [];
  const card = $('#token-status');
  if (!card || tokens.length === 0) return;
  const statuses = tokenStatuses(tokens, items);
  const joined = statuses.filter((s) => s.status === 'joined').length;
  const failed = statuses.filter((s) => s.status === 'failed').length;
  $('#ts-all-count').textContent = String(tokens.length);
  $('#ts-joined-count').textContent = String(joined);
  $('#ts-failed-count').textContent = String(failed);
  const filter = state.tokenFilter || 'all';
  const rows = $('#ts-rows');
  rows.innerHTML = '';
  tokens.forEach((tok, i) => {
    const st = statuses[i];
    if (filter !== 'all' && st.status !== filter) return;
    const row = document.createElement('div');
    row.className = 'ts-row';
    row.innerHTML = `
      <div class="ts-row-top">
        <span class="ts-token">${escapeHtml(tokenTail(tok))}</span>
        <button type="button" class="ts-copy" title="Copy token" aria-label="Copy token">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
      <div class="ts-pills">${renderResultPills(st)}</div>`;
    row.querySelector('.ts-copy').addEventListener('click', () => {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(tok).then(() => toast('Token copied')).catch(() => {});
      }
    });
    rows.appendChild(row);
  });
  card.classList.remove('hidden');
}
$$('.ts-tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.ts-tab').forEach((b) => b.classList.toggle('active', b === btn));
  state.tokenFilter = btn.dataset.tstab;
  renderTokenStatus(state.lastItems || []);
}));

/* ---- Discord invite preview ------------------------------------------ */
async function lookupInvite(rawValue, ids) {
  const code = String(rawValue || '').trim();
  const box = $(`#${ids.box}`);
  if (!box) return;
  if (!code) { box.classList.add('hidden'); return; }
  try {
    const info = await api(`${d('L2Jvb3N0L2ludml0ZS1pbmZvP2NvZGU9')}${encodeURIComponent(code)}`);
    if (state[ids.stateKey] !== code) return; // a newer value superseded us
    $(`#${ids.name}`).textContent = info.name || 'Unknown server';
    $(`#${ids.id}`).textContent = info.id ? `#${info.id}` : '';
    const icon = $(`#${ids.icon}`);
    if (info.icon) { icon.src = info.icon; icon.classList.remove('hidden'); }
    else { icon.classList.add('hidden'); }
    const dash = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
    $(`#${ids.members}`).textContent = dash(info.memberCount);
    $(`#${ids.online}`).textContent = dash(info.onlineCount);
    $(`#${ids.boosts}`).textContent = dash(info.boostCount);
    box.classList.remove('hidden');
  } catch {
    box.classList.add('hidden');
  }
}
function wireInvitePreview(inputSel, ids) {
  const input = $(inputSel);
  if (!input) return;
  input.addEventListener('input', () => {
    const val = input.value.trim();
    state[ids.stateKey] = val;
    clearTimeout(state[ids.timerKey]);
    state[ids.timerKey] = setTimeout(() => lookupInvite(val, ids), 450);
  });
}
wireInvitePreview('#invite', {
  box: 'invite-preview', name: 'ip-name', id: 'ip-id', icon: 'ip-icon',
  members: 'ip-members', online: 'ip-online', boosts: 'ip-boosts',
  stateKey: 'invitePreviewVal', timerKey: 'invitePreviewTimer',
});
wireInvitePreview('#redeem-invite', {
  box: 'pv-invite-preview', name: 'pv-ip-name', id: 'pv-ip-id', icon: 'pv-ip-icon',
  members: 'pv-ip-members', online: 'pv-ip-online', boosts: 'pv-ip-boosts',
  stateKey: 'pvInvitePreviewVal', timerKey: 'pvInvitePreviewTimer',
});

/* =======================================================================
 * BYOT BOOST TAB
 * ===================================================================== */
const inviteEl = $('#invite');
const tokensEl = $('#tokens');
const boostsEl = $('#boosts');
const retriesEl = $('#retries');
const startBtn = $('#start-btn');

function currentTokens() { return parseTokens(tokensEl.value); }

// Boosts to actually request: 0 means "use all tokens" (capped at 40).
function effectiveBoosts() {
  const requested = Number(boostsEl.value || 0);
  const maxBoosts = Math.min(40, currentTokens().length * state.settings.boostsPerToken);
  return requested > 0 ? Math.min(requested, 40) : Math.max(1, maxBoosts);
}

function updateTokenCounter() {
  const tokens = currentTokens();
  $('#token-counter').textContent = `${tokens.length} tokens loaded`;
  const maxBoosts = tokens.length * state.settings.boostsPerToken;
  boostsEl.max = Math.max(1, maxBoosts) > 40 ? 40 : Math.max(1, maxBoosts);
}

// The per-captcha price, guarding against a missing/NaN setting (which would
// otherwise zero out the whole estimate).
function captchaPrice() {
  const c = Number(state.settings.captchaCost);
  return Number.isFinite(c) && c > 0 ? c : DEFAULT_CAPTCHA_COST;
}

// Potential wallet cost: the worst case is one captcha solve per token in
// the field, so it scales directly with how many tokens are entered.
function estimatedCost() {
  return currentTokens().length * captchaPrice();
}

function userBalance() { return Number(state.user?.balance || 0); }

// Refresh the cost/balance strip; returns whether the wallet can cover it.
function refreshCost() {
  const cost = estimatedCost();
  const bal = userBalance();
  const note = $('#cost-note');
  if (!note) return true;
  // "You pay up to" — show the exact worst-case amount (1 token @ $0.015
  // shows exactly 0.015, never rounded up to 0.02 or down to 0.01).
  $('#cost-amount').textContent = fmtUSD(cost).slice(1);
  $('#cost-balance').textContent = fmtUSD(bal);
  const affordable = cost <= bal;
  note.classList.toggle('insufficient', cost > 0 && !affordable);
  return affordable;
}

function updateStartEnabled() {
  // 0 quantity is valid — it means "use every token". BYOT is paid from the
  // wallet, so the job must also fit the current balance.
  const hasInput = Boolean(inviteEl.value.trim()) && currentTokens().length > 0;
  startBtn.disabled = !(hasInput && refreshCost());
}

function scheduleQuote() {
  clearTimeout(state.quoteTimer);
  state.quoteTimer = setTimeout(refreshQuote, 400);
}

async function refreshQuote() {
  const tokens = currentTokens();
  const boosts = Number(boostsEl.value || 0);
  if (tokens.length === 0) {
    $('#quote-max').textContent = fmtUSD(0);
    $('#quote-tokens').textContent = '0';
    $('#quote-captcha').textContent = fmtUSD(0);
    return;
  }
  try {
    const q = await api(d('L2Jvb3N0L3F1b3Rl'), { method: 'POST', body: { tokens, boosts } });
    $('#quote-max').textContent = fmtUSD(q.estimatedMaxCost);
    $('#quote-tokens').textContent = String(q.tokensToUse ?? 0);
    $('#quote-captcha').textContent = fmtUSD(q.captchaCost);
  } catch {
    const bpt = state.settings.boostsPerToken;
    const tokensToUse = Math.min(tokens.length, Math.ceil((boosts || tokens.length * bpt) / bpt));
    const cost = tokensToUse * state.settings.captchaCost;
    $('#quote-max').textContent = fmtUSD(cost);
    $('#quote-tokens').textContent = String(tokensToUse);
    $('#quote-captcha').textContent = fmtUSD(cost);
  }
}

inviteEl.addEventListener('input', updateStartEnabled);
boostsEl.addEventListener('input', () => { updateStartEnabled(); scheduleQuote(); });
tokensEl.addEventListener('input', () => { updateTokenCounter(); updateStartEnabled(); scheduleQuote(); });

// "Paste from clipboard" button — drops the clipboard into the token field.
$('#b-wand').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    tokensEl.value = tokensEl.value ? `${tokensEl.value.replace(/\s*$/, '')}\n${text.trim()}` : text.trim();
    tokensEl.dispatchEvent(new Event('input'));
    tokensEl.focus();
  } catch (_) { /* clipboard unavailable — ignore */ }
});

startBtn.addEventListener('click', startBoost);

async function startBoost() {
  $('#boost-error').textContent = '';
  startBtn.disabled = true;
  const body = {
    invite: inviteEl.value.trim(),
    boosts: effectiveBoosts(),
    autoRetry: Number(retriesEl.value || 0) > 0,
    retries: Number(retriesEl.value || 0),
    tokens: currentTokens(),
  };
  try {
    const data = await api(d('L2Jvb3N0L3N0YXJ0'), { method: 'POST', body });
    if (data.balance !== undefined) setWalletUI(data.balance);
    state.currentJobId = data.job.id;
    state.startedAt = Date.now();
    // Seed the per-token list — every submitted token starts as "waiting".
    state.boostTokens = currentTokens();
    state.lastItems = [];
    state.tokenFilter = 'all';
    $$('.ts-tab').forEach((b) => b.classList.toggle('active', b.dataset.tstab === 'all'));
    renderTokenStatus([]);
    renderStatusBox('status', {
      stateText: 'Running...',
      delivered: 0,
      requested: body.boosts,
      tokensUsed: 0,
      cost: 0,
      startedAt: state.startedAt,
    });
    startPolling();
    toast('Boost job started!');
  } catch (err) {
    $('#boost-error').textContent = err.message;
    startBtn.disabled = false;
  }
}

function startPolling() { stopPolling(); pollOnce(); state.pollTimer = setInterval(pollOnce, 3000); }
function stopPolling() { if (state.pollTimer) clearInterval(state.pollTimer); state.pollTimer = null; }

async function pollOnce() {
  if (!state.currentJobId) return;
  try {
    const { job, balance } = await api(`${d('L2Jvb3N0L3N0YXR1cy8=')}${state.currentJobId}`);
    // Reflect captcha charges in the wallet as they happen.
    if (balance !== undefined) setWalletUI(balance);
    let label = 'Running...';
    if (job.status === 'completed') label = 'Completed!';
    else if (job.status === 'failed') label = 'Failed';
    renderStatusBox('status', {
      stateText: label,
      delivered: job.boostsDelivered,
      requested: job.boostsRequested,
      tokensUsed: job.tokensUsed,
      cost: job.cost,
      startedAt: state.startedAt,
    });
    // Refresh the per-token statuses live on every poll.
    try {
      const { items } = await api(`${d('L2Jvb3N0L2l0ZW1zLw==')}${state.currentJobId}`);
      state.lastItems = items || [];
      renderTokenStatus(state.lastItems);
    } catch { /* items are best-effort */ }
    if (job.status === 'completed' || job.status === 'failed') {
      stopPolling();
      startBtn.disabled = false;
      updateStartEnabled();
    }
  } catch (err) {
    $('#boost-error').textContent = err.message;
  }
}

/* =======================================================================
 * ACCOUNT / WALLET (Litecoin top-up via Tatum)
 * ===================================================================== */
async function loadBoostHistory() {
  try {
    const data = await api(d('L2Jvb3N0L2hpc3Rvcnk='));
    const jobs = data.jobs || [];
    const tbody = $('#boosts-table tbody');
    tbody.innerHTML = '';
    jobs.forEach((j) => {
      const boosts = `${j.boostsDelivered ?? 0}/${j.boostsRequested ?? 0}`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(j.createdAt).toLocaleDateString()}</td>
        <td class="mono">${escapeHtml(j.invite || '—')}</td>
        <td>${escapeHtml(boosts)}</td>
        <td><span class="pill ${escapeHtml(j.status)}">${escapeHtml(j.status)}</span></td>`;
      tbody.appendChild(tr);
    });
    $('#boosts-empty').classList.toggle('hidden', jobs.length > 0);
    $('#boosts-table').classList.toggle('hidden', jobs.length === 0);
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#topup-amount').addEventListener('input', updateTopupPreview);

function updateTopupPreview() {
  const usd = Number($('#topup-amount').value || 0);
  const el = $('#topup-preview');
  if (!el) return;
  if (usd > 0 && state.ltcRate) {
    el.textContent = `≈ ${(usd / state.ltcRate).toFixed(8)} LTC  ·  1 LTC = $${state.ltcRate.toFixed(2)}`;
  } else {
    el.textContent = '≈ — LTC';
  }
}

$('#topup-btn').addEventListener('click', async () => {
  const msg = $('#topup-message');
  msg.className = 'form-message';
  msg.textContent = '';
  const amount = Number($('#topup-amount').value || 0);
  if (!(amount > 0)) {
    msg.classList.add('error');
    msg.textContent = 'Enter a valid USD amount';
    return;
  }
  $('#topup-btn').disabled = true;
  try {
    const { deposit, qr } = await api(d('L3dhbGxldC9kZXBvc2l0'), { method: 'POST', body: { amount } });
    showDeposit(deposit, qr);
    startDepositPolling(deposit.id);
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  } finally {
    $('#topup-btn').disabled = false;
  }
});

function showDeposit(deposit, qr) {
  $('#deposit-box').classList.remove('hidden');
  $('#deposit-ltc').textContent = `${Number(deposit.ltcAmount).toFixed(8)} LTC`;
  $('#deposit-usd').textContent =
    deposit.usdAmount != null ? `(≈ $${Number(deposit.usdAmount).toFixed(2)})` : '';
  $('#deposit-address').textContent = deposit.address;
  const img = $('#deposit-qr');
  if (qr) { img.src = qr; img.style.display = 'block'; }
  else { img.removeAttribute('src'); img.style.display = 'none'; }
  setDepositStatus(deposit);
}

function setDepositStatus(deposit) {
  const el = $('#deposit-status');
  if (deposit.status === 'completed') {
    el.textContent = `Payment received — $${Number(deposit.receivedUsd ?? 0).toFixed(2)} added to your balance`;
    el.className = 'deposit-status success';
  } else if (deposit.status === 'failed') {
    el.textContent = 'Deposit failed';
    el.className = 'deposit-status error';
  } else {
    const rec = Number(deposit.received || 0);
    el.textContent = rec > 0
      ? `Detected ${rec.toFixed(8)} LTC, waiting for confirmation…`
      : 'Waiting for payment…';
    el.className = 'deposit-status';
  }
}

$('#copy-address-btn').addEventListener('click', async () => {
  const text = $('#deposit-address').textContent;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  const btn = $('#copy-address-btn');
  const original = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = original; }, 1200);
});

function startDepositPolling(id) {
  stopDepositPolling();
  state.topupDepositId = id;
  depositPollOnce();
  state.topupPollTimer = setInterval(depositPollOnce, 8000);
}
function stopDepositPolling() {
  if (state.topupPollTimer) clearInterval(state.topupPollTimer);
  state.topupPollTimer = null;
}
async function depositPollOnce() {
  if (!state.topupDepositId) return;
  try {
    const data = await api(`${d('L3dhbGxldC9kZXBvc2l0Lw==')}${state.topupDepositId}`);
    setDepositStatus(data.deposit);
    setWalletUI(data.balance);
    if (data.deposit.status === 'completed' || data.deposit.status === 'failed') {
      stopDepositPolling();
      loadDeposits();
    }
  } catch { /* keep polling */ }
}

async function loadDeposits() {
  try {
    const data = await api(d('L3dhbGxldC9kZXBvc2l0cw=='));
    const tbody = $('#deposits-table tbody');
    tbody.innerHTML = '';
    data.deposits.forEach((d) => {
      const amt = d.status === 'completed'
        ? `$${Number(d.receivedUsd ?? 0).toFixed(2)}`
        : (d.usdAmount != null ? `$${Number(d.usdAmount).toFixed(2)}` : '—');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(d.createdAt).toLocaleString()}</td>
        <td>${amt}</td>
        <td><span class="pill ${d.status}">${d.status}</span></td>`;
      tbody.appendChild(tr);
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* =======================================================================
 * ADMIN
 * ===================================================================== */
function enterAdmin() {
  if (state.adminUnlocked) {
    $('#admin-lock').classList.remove('centered');
    $('#admin-content').classList.remove('hidden');
    loadAdmin();
  } else {
    $('#admin-lock').classList.add('centered');
    $('#admin-content').classList.add('hidden');
    $('#admin-lock-message').textContent = '';
    $('#admin-password').value = '';
    $('#admin-password').focus();
  }
}

async function unlockAdmin() {
  const msg = $('#admin-lock-message');
  msg.className = 'form-message';
  msg.textContent = '';
  try {
    await api(d('L2FkbWluL3VubG9jaw=='), { method: 'POST', body: { password: $('#admin-password').value } });
    state.adminUnlocked = true;
    $('#admin-lock').classList.remove('centered');
    $('#admin-content').classList.remove('hidden');
    loadAdmin();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = `${err.message}`;
  }
}
$('#admin-unlock-btn').addEventListener('click', unlockAdmin);
$('#admin-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockAdmin(); });

async function loadAdmin() {
  if (state.user?.role !== 'admin') return;
  loadKeysGrid();
  loadTokensTable();
  loadUsersTable();
  loadPricing();
}

// --- Users (give/remove wallet balance) ---
async function loadUsersTable() {
  try {
    const data = await api(d('L2FkbWluL3VzZXJz'));
    const tbody = $('#users-table tbody');
    tbody.innerHTML = '';
    data.users.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td><span class="pill ${u.role === 'admin' ? 'completed' : 'pending'}">${escapeHtml(u.role)}</span></td>
        <td class="mono" id="user-balance-${escapeHtml(u.id)}">${fmtUSD(u.balance)}</td>
        <td>${new Date(u.createdAt).toLocaleDateString()}</td>
        <td class="cell-action"></td>`;
      const cell = tr.querySelector('.cell-action');
      const wrap = document.createElement('div');
      wrap.className = 'balance-give';
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.01';
      input.placeholder = '10.00';
      const btn = document.createElement('button');
      btn.className = 'btn btn-mini btn-primary';
      btn.textContent = 'Add';
      btn.addEventListener('click', () => giveUserBalance(u.id, input, btn));
      wrap.appendChild(input);
      wrap.appendChild(btn);
      cell.appendChild(wrap);
      tbody.appendChild(tr);
    });
    $('#users-summary').textContent = `${data.users.length} total`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function giveUserBalance(userId, input, btn) {
  const amount = Number(input.value);
  if (!Number.isFinite(amount) || amount === 0) {
    toast('Enter a non-zero amount', 'error');
    return;
  }
  btn.disabled = true;
  try {
    const data = await api(`${d('L2FkbWluL3VzZXJzLw==')}${userId}${d('L2JhbGFuY2U=')}`, { method: 'PATCH', body: { amount } });
    $(`#user-balance-${userId}`).textContent = fmtUSD(data.user.balance);
    input.value = '';
    toast(data.message);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Stock tokens ---
$('#save-tokens-btn').addEventListener('click', async () => {
  const msg = $('#admin-tokens-message');
  msg.className = 'form-message';
  const tokens = parseTokens($('#admin-tokens').value);
  if (tokens.length === 0) {
    msg.classList.add('error');
    msg.textContent = 'Paste at least one token';
    return;
  }
  try {
    const data = await api(d('L2FkbWluL3Rva2Vucw=='), { method: 'POST', body: { tokens } });
    msg.classList.add('success');
    msg.textContent = data.message;
    $('#admin-tokens').value = '';
    loadTokensTable();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

async function loadTokensTable() {
  try {
    const data = await api(d('L2FkbWluL3Rva2Vucw=='));
    const tbody = $('#tokens-table tbody');
    tbody.innerHTML = '';
    data.tokens.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escapeHtml(t.preview)}</td>
        <td><span class="pill ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
        <td>${new Date(t.createdAt).toLocaleDateString()}</td>
        <td class="cell-action"></td>`;
      const actions = tr.querySelector('.cell-action');

      const copyBtn = document.createElement('button');
      copyBtn.className = 'icon-btn';
      copyBtn.title = 'Copy full token';
      copyBtn.setAttribute('aria-label', 'Copy full token');
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      copyBtn.addEventListener('click', () => copyStockToken(t.id));
      actions.appendChild(copyBtn);

      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn';
      editBtn.title = 'Edit token';
      editBtn.setAttribute('aria-label', 'Edit token');
      editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>';
      editBtn.addEventListener('click', () => editStockToken(t.id));
      actions.appendChild(editBtn);

      const del = document.createElement('button');
      del.className = 'icon-del';
      del.title = 'Delete token';
      del.setAttribute('aria-label', 'Delete token');
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      del.addEventListener('click', () => deleteToken(t.id, del));
      actions.appendChild(del);

      tbody.appendChild(tr);
    });
    $('#tokens-summary').textContent = `${data.unused} unused / ${data.total} total`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteToken(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`${d('L2FkbWluL3Rva2Vucy8=')}${id}`, { method: 'DELETE' });
    toast('Token deleted');
    loadTokensTable();
  } catch (err) {
    toast(err.message, 'error');
    if (btn) btn.disabled = false;
  }
}

// Copy a single stock token's full (unmasked) value to the clipboard.
async function copyStockToken(id) {
  try {
    const { token } = await api(`${d('L2FkbWluL3Rva2Vucy8=')}${id}${d('L3Jhdw==')}`);
    if (navigator.clipboard) await navigator.clipboard.writeText(token);
    toast('Token copied');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Edit a single stock token's value in place.
async function editStockToken(id) {
  try {
    const { token: current } = await api(`${d('L2FkbWluL3Rva2Vucy8=')}${id}${d('L3Jhdw==')}`);
    const next = prompt('Edit token:', current);
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    await api(`${d('L2FkbWluL3Rva2Vucy8=')}${id}`, { method: 'PATCH', body: { token: trimmed } });
    toast('Token updated');
    loadTokensTable();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#delete-all-tokens-btn').addEventListener('click', async () => {
  if (!confirm('Delete ALL stock tokens? This cannot be undone.')) return;
  try {
    await api(d('L2FkbWluL3Rva2Vucw=='), { method: 'DELETE' });
    toast('All stock tokens deleted');
    loadTokensTable();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Bulk edit / copy (unused stock as one big text field) ---
$('#load-tokens-btn').addEventListener('click', async () => {
  const msg = $('#admin-tokens-bulk-message');
  msg.className = 'form-message';
  msg.textContent = '';
  try {
    const { tokens } = await api(d('L2FkbWluL3Rva2Vucy9leHBvcnQ/c3RhdHVzPXVudXNlZA=='));
    $('#admin-tokens-bulk').value = tokens.join('\n');
    toast(`Loaded ${tokens.length} unused tokens`);
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

$('#copy-tokens-btn').addEventListener('click', async () => {
  const text = $('#admin-tokens-bulk').value;
  if (!text) { toast('Nothing to copy — load the stock first', 'error'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    const ta = $('#admin-tokens-bulk');
    ta.focus();
    ta.select();
    document.execCommand('copy');
    window.getSelection()?.removeAllRanges();
    toast('Copied to clipboard');
  }
});

$('#save-tokens-bulk-btn').addEventListener('click', async () => {
  const msg = $('#admin-tokens-bulk-message');
  msg.className = 'form-message';
  msg.textContent = '';
  const tokens = parseTokens($('#admin-tokens-bulk').value);
  try {
    const data = await api(d('L2FkbWluL3Rva2Vucy91bnVzZWQ='), { method: 'PUT', body: { tokens } });
    msg.classList.add('success');
    msg.textContent = data.message;
    loadTokensTable();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

// --- Keys ---
$('#generate-keys-btn').addEventListener('click', async () => {
  const msg = $('#gen-keys-message');
  msg.className = 'form-message';
  const boostsPerKey = Number($('#gen-boosts').value || 0);
  const count = Number($('#gen-count').value || 0);
  try {
    const data = await api(d('L2FkbWluL2tleXM='), { method: 'POST', body: { boostsPerKey, count } });
    msg.classList.add('success');
    msg.textContent = `${data.message}`;
    // Show the freshly generated keys, one per line, ready to copy.
    const codes = data.keys.map((k) => k.code).join('\n');
    $('#gen-keys-output').value = codes;
    $('#gen-result-label').textContent = `${data.keys.length} generated keys (one per line)`;
    $('#gen-result').classList.remove('hidden');
    loadKeysGrid();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

// Copy the just-generated keys to the clipboard.
$('#copy-keys-btn').addEventListener('click', async () => {
  const output = $('#gen-keys-output');
  const text = output.value;
  if (!text) return;
  const btn = $('#copy-keys-btn');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers without the async clipboard API.
    output.focus();
    output.select();
    document.execCommand('copy');
    window.getSelection()?.removeAllRanges();
  }
  const original = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = original; }, 1500);
});

async function loadKeysGrid() {
  try {
    const data = await api(d('L2FkbWluL2tleXM='));
    const grid = $('#keys-grid');
    grid.innerHTML = '';
    data.keys.forEach((k) => {
      const div = document.createElement('div');
      div.className = `key-chip ${k.redeemed ? 'redeemed' : ''}`;
      div.innerHTML = `
        <span class="code">${k.code}</span>
        <span class="val">+${k.boosts} boosts${k.redeemed ? ' · used' : ''}</span>`;
      const del = document.createElement('button');
      del.className = 'chip-del';
      del.title = 'Delete key';
      del.setAttribute('aria-label', 'Delete key');
      del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      del.addEventListener('click', () => deleteKey(k.code, del));
      div.appendChild(del);
      grid.appendChild(div);
    });
    const unused = data.keys.filter((k) => !k.redeemed).length;
    $('#keys-summary').textContent = `${unused} unused / ${data.keys.length} total`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteKey(code, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`${d('L2FkbWluL2tleXMv')}${encodeURIComponent(code)}`, { method: 'DELETE' });
    toast('Key deleted');
    loadKeysGrid();
  } catch (err) {
    toast(err.message, 'error');
    if (btn) btn.disabled = false;
  }
}

$('#delete-all-keys-btn').addEventListener('click', async () => {
  if (!confirm('Delete ALL keys? This cannot be undone.')) return;
  try {
    await api(d('L2FkbWluL2tleXM='), { method: 'DELETE' });
    toast('All keys deleted');
    loadKeysGrid();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- Pricing & support link ---
async function loadPricing() {
  try {
    const s = await api(d('L2FkbWluL3NldHRpbmdz'));
    $('#price-captcha').value = s.captchaCost;
    $('#support-url').value = s.supportUrl || '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#save-support-btn').addEventListener('click', async () => {
  const msg = $('#support-message');
  msg.className = 'form-message';
  msg.textContent = '';
  try {
    await api(d('L2FkbWluL3NldHRpbmdz'), {
      method: 'PATCH',
      body: { supportUrl: $('#support-url').value.trim() },
    });
    msg.classList.add('success');
    msg.textContent = 'Saved';
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

$('#save-pricing-btn').addEventListener('click', async () => {
  const msg = $('#pricing-message');
  msg.className = 'form-message';
  const captchaCost = Number($('#price-captcha').value);
  if (Number.isNaN(captchaCost) || captchaCost < 0) {
    msg.classList.add('error');
    msg.textContent = 'Price must be a non-negative number';
    return;
  }
  try {
    const data = await api(d('L2FkbWluL3NldHRpbmdz'), { method: 'PATCH', body: { captchaCost } });
    msg.classList.add('success');
    msg.textContent = `${data.message}`;
    state.settings.captchaCost = data.settings.captchaCost;
    applySettingsToUI();
    refreshQuote();
  } catch (err) {
    msg.classList.add('error');
    msg.textContent = err.message;
  }
});

/* =======================================================================
 * BOOTSTRAP
 * ===================================================================== */
async function init() {
  updateTokenCounter();
  updateStartEnabled();
  loadConfig();

  if (state.token) {
    try {
      const data = await api(d('L2F1dGgvbWU='));
      state.user = data.user;
      showApp();
      renderBalance();
      loadSettings();
      return;
    } catch {
      localStorage.removeItem('db_token');
      state.token = null;
    }
  }
  showView('public');
}

init();
