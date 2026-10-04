'use strict';

/* =========================================================================
 * Ninja Boost — standalone reseller redeem page  (/r/<name>)
 *
 * This page is deliberately separate from the main panel: no login, no
 * account, no token, no dashboard. It only
 *   1. loads the page owner's look (colour / icon / name / support link),
 *   2. previews the Discord server from its invite,
 *   3. redeems a key that belongs to THIS reseller, and shows the result.
 * Requests are sent WITHOUT credentials, and the server rejects any key that
 * isn't owned by the page's reseller.
 * ========================================================================= */
(function () {
  const API = '/api';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const m = location.pathname.match(/^\/r\/([A-Za-z0-9-]{3,32})\/?$/);
  const ref = m ? m[1].toLowerCase() : null;
  const S = { supportUrl: '', jobId: null, pollTimer: null, inviteTimer: null, inviteVal: '' };

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      credentials: 'omit',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

  function show(view) {
    $('#redeem-view').classList.toggle('hidden', view !== 'redeem');
    $('#result-view').classList.toggle('hidden', view !== 'result');
    $('#notfound-view').classList.toggle('hidden', view !== 'notfound');
  }

  /* ------------------------------ branding ------------------------------ */
  function applyBranding(page) {
    const heading = page.title || page.brand;
    if (heading) {
      $('.brand-top').textContent = heading;
      document.title = heading;
    }
    if (page.color && window.NBTheme) window.NBTheme.apply(page.color);
    if (page.brand) $$('.logo-word').forEach((n) => { n.textContent = page.brand; });
    if (page.icon && /^(data:image\/|https:\/\/)/.test(page.icon)) {
      $$('.logo-img, .auth-logo-img').forEach((img) => {
        img.src = page.icon;
        if (page.brand) img.alt = page.brand;
      });
      const fav = document.querySelector('link[rel="icon"]');
      if (fav) { fav.removeAttribute('type'); fav.href = page.icon; }
    }
    S.supportUrl = /^https?:\/\//i.test(page.supportUrl || '') ? page.supportUrl : '';
  }

  // The logo isn't a link on a reseller page.
  $$('.logo, .auth-logo').forEach((a) => {
    a.setAttribute('href', '#');
    a.addEventListener('click', (e) => e.preventDefault());
  });

  /* --------------------------- invite preview --------------------------- */
  async function lookupInvite(raw, ids) {
    const code = String(raw || '').trim();
    const box = $(`#${ids.box}`);
    if (!box) return;
    if (!code) { box.classList.add('hidden'); return; }
    try {
      const info = await api(`/boost/invite-info?code=${encodeURIComponent(code)}`);
      if (ids.check && S.inviteVal !== code) return; // a newer value superseded us
      $(`#${ids.name}`).textContent = info.name || 'Unknown server';
      $(`#${ids.id}`).textContent = info.id ? `#${info.id}` : '';
      const icon = $(`#${ids.icon}`);
      if (info.icon) { icon.src = info.icon; icon.classList.remove('hidden'); } else { icon.classList.add('hidden'); }
      const dash = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
      $(`#${ids.members}`).textContent = dash(info.memberCount);
      $(`#${ids.online}`).textContent = dash(info.onlineCount);
      $(`#${ids.boosts}`).textContent = dash(info.boostCount);
      box.classList.remove('hidden');
    } catch {
      box.classList.add('hidden');
    }
  }
  const PREVIEW_IDS = { box: 'pv-invite-preview', name: 'pv-ip-name', id: 'pv-ip-id', icon: 'pv-ip-icon', members: 'pv-ip-members', online: 'pv-ip-online', boosts: 'pv-ip-boosts', check: true };
  const RESULT_IDS = { box: 'rr-server', name: 'rr-ip-name', id: 'rr-ip-id', icon: 'rr-ip-icon', members: 'rr-ip-members', online: 'rr-ip-online', boosts: 'rr-ip-boosts', check: false };

  $('#redeem-invite').addEventListener('input', () => {
    const val = $('#redeem-invite').value.trim();
    S.inviteVal = val;
    clearTimeout(S.inviteTimer);
    S.inviteTimer = setTimeout(() => lookupInvite(val, PREVIEW_IDS), 450);
  });

  /* -------------------------------- redeem ------------------------------ */
  async function doRedeem() {
    const msg = $('#redeem-message');
    msg.className = 'form-message';
    msg.textContent = '';
    const invite = $('#redeem-invite').value.trim();
    const key = $('#redeem-key').value.trim();
    if (!invite) { msg.classList.add('error'); msg.textContent = 'Enter an invite link'; return; }
    if (!key) { msg.classList.add('error'); msg.textContent = 'Enter your key'; return; }

    const btn = $('#p-start');
    btn.disabled = true;
    try {
      const data = await api('/boost/redeem', { method: 'POST', body: { invite, key, ref } });
      S.jobId = data.job.id;
      $('#rr-key').textContent = key;
      $('#rr-tokens').textContent = data.job.tokensUsed;
      renderResult({ status: 'running', delivered: data.keyDelivered, requested: data.keyTotal });
      setupSupport();
      lookupInvite(invite, RESULT_IDS);
      show('result');
      startPolling();
    } catch (err) {
      msg.classList.add('error');
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('#p-start').addEventListener('click', doRedeem);
  ['#redeem-key', '#redeem-invite'].forEach((sel) => {
    $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRedeem(); } });
  });

  function renderResult({ status, delivered, requested, retryCount }) {
    $('#rr-status-section').classList.toggle('hidden', status === 'completed');
    $('#rr-ring-wrap').className = `rr-ring-wrap ${status}`;
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
    $('#rr-support-note').textContent = 'Not all boosts could be delivered — please contact support below.';
    const label = $('#rr-support-label');
    if (label) label.textContent = 'Contact support';
  }

  function setupSupport() {
    const a = $('#rr-support');
    if (S.supportUrl) { a.href = S.supportUrl; a.classList.remove('hidden'); } else { a.classList.add('hidden'); }
  }

  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }
  function startPolling() {
    stopPolling();
    pollOnce();
    S.pollTimer = setInterval(pollOnce, 3000);
  }
  async function pollOnce() {
    if (!S.jobId) return;
    try {
      const { job, keyTotal, keyDelivered } = await api(`/boost/redeem/status/${encodeURIComponent(S.jobId)}`);
      const status = job.status === 'completed' || job.status === 'failed' ? job.status : 'running';
      renderResult({
        status,
        delivered: keyDelivered ?? job.boostsDelivered,
        requested: keyTotal ?? job.boostsRequested,
        retryCount: job.retryCount || 0,
      });
      if (status !== 'running') stopPolling();
    } catch { /* keep polling */ }
  }

  $('#rr-back').addEventListener('click', () => {
    stopPolling();
    S.jobId = null;
    $('#redeem-key').value = '';
    show('redeem');
  });

  /* --------------------------------- boot ------------------------------- */
  (async function init() {
    if (!ref) return show('notfound');
    try {
      applyBranding(await api(`/config/page/${encodeURIComponent(ref)}`));
      show('redeem');
    } catch (err) {
      // Unknown page -> dead end. Never fall back to the main panel.
      if (err.status === 404) show('notfound');
      else show('redeem'); // network hiccup: the server already rendered the page
    }
  })();
})();
