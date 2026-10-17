'use strict';

/* =========================================================================
 * Ninja Boost — live progress page for a direct SellAuth order  (/status/<id>)
 * Public and read-only: no login, no account, no key shown. It just asks the
 * server how the boost is going and redraws the progress ring.
 * ========================================================================= */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const m = location.pathname.match(/^\/status\/([0-9a-f-]{36})\/?$/i);
  const id = m ? m[1].toLowerCase() : null;
  let timer = null;
  let invited = false;

  async function api(path) {
    const res = await fetch(`/api${path}`, { credentials: 'omit', cache: 'no-store' });
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
    $('#status-view').classList.toggle('hidden', view !== 'status');
    $('#notfound-view').classList.toggle('hidden', view !== 'notfound');
  }

  // The seller's logo is not a link here.
  document.querySelectorAll('.logo, .auth-logo').forEach((a) => {
    a.setAttribute('href', '#');
    a.addEventListener('click', (e) => e.preventDefault());
  });

  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (!Number.isFinite(s)) return '—';
    if (s < 15) return 'just now';
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    return new Date(iso).toLocaleString();
  }

  async function showServer(invite) {
    if (invited || !invite) return;
    invited = true;
    try {
      const info = await api(`/boost/invite-info?code=${encodeURIComponent(invite)}`);
      $('#rr-ip-name').textContent = info.name || 'Unknown server';
      $('#rr-ip-id').textContent = info.id ? `#${info.id}` : '';
      const icon = $('#rr-ip-icon');
      if (info.icon) { icon.src = info.icon; icon.classList.remove('hidden'); } else { icon.classList.add('hidden'); }
      const dash = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
      $('#rr-ip-members').textContent = dash(info.memberCount);
      $('#rr-ip-online').textContent = dash(info.onlineCount);
      $('#rr-ip-boosts').textContent = dash(info.boostCount);
      $('#rr-server').classList.remove('hidden');
    } catch {
      $('#rr-server').classList.add('hidden');
    }
  }

  function render(d) {
    const status = d.status;
    $('#rr-status-section').classList.toggle('hidden', status === 'completed');
    $('#rr-ring-wrap').className = `rr-ring-wrap ${status}`;
    $('#rr-icon-check').classList.toggle('hidden', status !== 'completed');
    $('#rr-icon-x').classList.toggle('hidden', status !== 'failed');
    $('#rr-ring-count').textContent = `${d.delivered}/${d.requested}`;

    const st = $('#rr-state');
    st.textContent = status === 'completed' ? 'Boost successful!' : status === 'failed' ? 'Boost incomplete' : 'Boosting your server…';
    st.className = `rr-status-title ${status === 'running' ? '' : status}`;

    $('#rr-delivered').textContent = d.delivered;
    $('#rr-requested').textContent = d.requested;
    $('#rr-boosts').textContent = `${d.delivered}/${d.requested}`;
    $('#rr-invite').textContent = d.invite ? `discord.gg/${d.invite}` : '—';
    $('#rr-updated').textContent = ago(d.updatedAt);

    const note = $('#rr-support-note');
    note.classList.toggle('hidden', status !== 'failed');
    note.textContent = 'Not all boosts could be delivered — please contact support below and mention this page.';

    const a = $('#rr-support');
    const label = $('#rr-support-label');
    if (d.supportUrl && status !== 'running') {
      a.href = d.supportUrl;
      if (label) label.textContent = 'Contact support';
      a.classList.remove('hidden');
    } else {
      a.classList.add('hidden');
    }
    showServer(d.invite);
  }

  async function poll() {
    try {
      const d = await api(`/status/${encodeURIComponent(id)}`);
      render(d);
      show('status');
      if (d.status !== 'running') { clearInterval(timer); timer = null; }
    } catch (err) {
      if (err.status === 404) { clearInterval(timer); timer = null; show('notfound'); }
      // any other hiccup: keep polling, the last picture stays on screen
    }
  }

  if (!id) { show('notfound'); return; }
  poll();
  timer = setInterval(poll, 6000);
})();
