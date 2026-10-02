'use strict';

/* =========================================================================
 * Ninja Boost — reseller pages of the customer dashboard
 *
 * Files (own stock) · Keys · API · Orders · Redeem Page · password change.
 * Loaded BEFORE app.js, which calls NBReseller.onLogin() / reset(). Plain JS,
 * no build step. Values are always inserted with textContent, never
 * innerHTML, so nothing from the database can inject markup (CSP forbids
 * inline handlers anyway).
 * ========================================================================= */
// DOM quirk: replaceChildren(null) prints the text "null". Drop empty children
// so optional blocks (`cond ? el(...) : null`) simply don't render.
(function () {
  const orig = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    return orig.apply(this, nodes.flat().filter((n) => n != null && n !== false));
  };
})();

(function () {
  const API = '/api';
  const S = { me: null, keys: [], filter: 'all', q: '' };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

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

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    const token = localStorage.getItem('db_token');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, type = 'success') {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  async function copy(text, label = 'Copied') {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(label);
  }

  function download(name, text) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
    document.body.append(a); a.click(); a.remove();
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

  // Disable a button while its async handler runs; surface errors as toasts.
  const act = (fn) => async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try { await fn(e); } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
  };
  const btn = (label, fn, cls = 'btn-ghost btn-mini') => el('button', { type: 'button', class: `btn ${cls}`, onclick: act(fn), text: label });

  const pill = (status) => el('span', { class: `rs-pill ${({ completed: 'ok', running: 'warn', pending: 'warn', partial: 'warn', failed: 'bad', unused: 'ok', joined: 'ok', already_in: 'ok', valid: 'ok', locked: 'warn', invalid: 'bad', error: 'bad' })[status] || ''}`, text: String(status).replace(/_/g, ' ') });

  function card(title, sub, ...body) {
    return el('section', { class: 'rs-card' },
      (title || sub) && el('div', { class: 'rs-head' }, title && el('h2', { text: title }), sub && el('p', { text: sub })),
      ...body);
  }
  function table(cols, rows, emptyText) {
    if (!rows.length) return el('div', { class: 'rs-empty', text: emptyText });
    return el('div', { class: 'rs-table' }, el('table', {},
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: c.num ? 'num' : '', text: c.label })))),
      el('tbody', {}, rows)));
  }
  const kpi = (label, value, small) => el('div', { class: 'rs-kpi' }, el('span', { text: label }), el('b', { text: value }), small && el('small', { text: small }));
  const field = (label, input, help) => el('label', { class: 'rs-field' }, el('span', { text: label }), input, help && el('small', { text: help }));
  const input = (props) => el('input', { class: 'rs-input', ...props });

  /* ------------------------------ session ------------------------------ */
  async function refreshMe() {
    try { S.me = await api('/reseller/me'); } catch { S.me = { enabled: false }; }
    const on = Boolean(S.me.enabled);
    $$('.reseller-only').forEach((n) => n.classList.toggle('hidden', !on));
    if (on) {
      $('#ss-stock').textContent = num(S.me.stock.unused);
      $('#ss-keys').textContent = num(S.me.keys.unused);
      $('#ss-boosts').textContent = num(S.me.boostsDelivered);
    }
    return on;
  }

  async function onLogin() {
    renderPassword();
    await refreshMe();
    const active = $('.tab-panel.active')?.id?.replace('tab-', '');
    if (active) load(active);
  }
  function reset() {
    stopJoinPoll();
    stopCheckPoll();
    S.me = null;
    $$('.reseller-only').forEach((n) => n.classList.add('hidden'));
  }

  const LOADERS = { files: renderFiles, joiner: renderJoiner, keys: renderKeys, api: renderApi, page: renderPage, history: renderOrders };
  async function load(tab) {
    const fn = LOADERS[tab];
    if (!fn || !S.me?.enabled) return;
    try { await fn(); } catch (err) { toast(err.message, 'error'); }
  }
  $$('.acc-btn[data-tab]').forEach((b) => b.addEventListener('click', () => { stopJoinPoll(); stopCheckPoll(); load(b.dataset.tab); }));

  const panel = (id) => $(`#tab-${id}`);
  const title = (t, sub) => [el('h1', { class: 'title', text: t }), el('p', { class: 'subtitle', text: sub })];

  /* ------------------------------- Files ------------------------------- */
  async function renderFiles() {
    const d = await api('/reseller/stock');
    const add = el('textarea', { class: 'rs-input rs-mono', rows: 6, placeholder: 'email:password:TOKEN\nTOKEN\nuser:pass:TOKEN' });
    const file = el('input', {
      type: 'file', accept: '.txt,.csv,text/plain', class: 'rs-hidden',
      onchange: async () => {
        const f = file.files[0];
        if (!f) return;
        const text = await f.text();
        add.value = add.value ? `${add.value.replace(/\s*$/, '')}\n${text.trim()}` : text.trim();
        file.value = '';
        toast(`${f.name} loaded — press “Add to stock”`);
      },
    });
    const reload = async () => { await refreshMe(); await renderFiles(); };

    panel('files').replaceChildren(
      ...title('Files', 'Your own token stock. Keys you generate only ever use these tokens.'),
      el('div', { class: 'rs-grid rs-g3' }, kpi('Unused', num(d.unused), 'ready for a boost'), kpi('Used', num(d.used), 'already spent'),
        kpi('Needed', num(d.tokensNeeded), `for your unused keys (${d.boostsPerToken} boosts per token)`)),
      d.unused < d.tokensNeeded
        ? el('div', { class: 'rs-note warn', text: `Short by ${num(d.tokensNeeded - d.unused)} token${d.tokensNeeded - d.unused > 1 ? 's' : ''}: some of your unused keys would fail to redeem.` })
        : null,
      checkerCard(d.unused, reload),
      card('Add tokens', 'Paste them or load a .txt file — one per line. Tokens already on the platform are skipped.',
        add, file,
        el('div', { class: 'rs-actions' },
          btn('Load a file', () => file.click(), 'btn-ghost btn-mini'),
          btn('Add to stock', async () => {
            const tokens = add.value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
            if (!tokens.length) throw new Error('Paste at least one token');
            const r = await api('/reseller/stock', { method: 'POST', body: { tokens } });
            toast(r.message); add.value = ''; await reload();
          }, 'btn-primary btn-mini'))),
      card('Your tokens', `Newest 300 shown · ${num(d.unused + d.used)} in total`,
        el('div', { class: 'rs-actions' },
          btn('Export unused', async () => {
            const r = await api('/reseller/stock/export');
            if (!r.tokens.length) throw new Error('No unused token');
            download('unused-tokens.txt', r.tokens.join('\n'));
          }),
          btn('Delete unused', async () => {
            if (!confirm('Delete ALL your unused tokens? This cannot be undone.')) return;
            await api('/reseller/stock?scope=unused', { method: 'DELETE' }); toast('Unused tokens deleted'); await reload();
          }, 'btn-ghost btn-mini rs-danger'),
          btn('Delete used', async () => {
            if (!confirm('Delete your used tokens from the list?')) return;
            await api('/reseller/stock?scope=used', { method: 'DELETE' }); toast('Used tokens deleted'); await reload();
          }, 'btn-ghost btn-mini rs-danger')),
        table([{ label: 'Token' }, { label: 'Status' }, { label: 'Added' }, { label: '' }],
          d.tokens.map((t) => el('tr', {},
            el('td', { class: 'rs-mono', text: t.preview }), el('td', {}, pill(t.status)), el('td', { class: 'rs-muted', text: ago(t.createdAt) }),
            el('td', { class: 'rs-act' }, btn('Delete', async () => { await api(`/reseller/stock/${t.id}`, { method: 'DELETE' }); await reload(); }, 'btn-ghost btn-mini rs-danger')))),
          'Your stock is empty — add tokens above.')));
  }

  /* --------------------------- Token checker --------------------------- */
  let checkTimer = null;
  let purgedCheck = null;                       // { id, deleted } — hides stale results after a purge
  function stopCheckPoll() { clearInterval(checkTimer); checkTimer = null; }

  function checkerCard(unused, reload) {
    const host = el('div', { class: 'rs-out' });
    const startBtn = btn('Check my tokens', async () => {
      const r = await api('/reseller/stock/check', { method: 'POST' });
      toast(r.message); purgedCheck = null; watch(r.check.id);
    }, 'btn-primary btn-mini');
    if (!unused) startBtn.disabled = true;

    const dead = (label, n, statuses, id) => btn(`${label} (${num(n)})`, async () => {
      if (!n) throw new Error('Nothing to delete');
      if (!confirm(`Delete ${n} ${label.toLowerCase().replace('delete ', '')} token${n > 1 ? 's' : ''} from your stock?`)) return;
      const r = await api(`/reseller/stock/check/${id}/purge`, { method: 'POST', body: { statuses } });
      purgedCheck = { id, deleted: r.deleted }; toast(r.message); await reload();
    }, 'btn-ghost btn-mini rs-danger');

    async function showResults(id) {
      const r = await api(`/reseller/stock/check/${id}/results`);
      const m = r.summary;
      host.replaceChildren(
        el('div', { class: 'rs-grid rs-g3' },
          kpi('Valid', num(m.valid), `${num(m.nitro)} with Nitro`),
          kpi('Locked', num(m.locked), 'need phone / email / re-verify'),
          kpi('Invalid', num(m.invalid), 'dead tokens')),
        el('p', { class: 'rs-muted', text: `${num(m.freeSlots)} free boost slot${m.freeSlots === 1 ? '' : 's'} on valid accounts · checked ${ago(r.check.finishedAt || r.check.createdAt)}${m.error ? ` · ${m.error} could not be read` : ''}` }),
        el('div', { class: 'rs-actions' }, dead('Delete invalid', m.invalid, ['invalid'], id), dead('Delete locked', m.locked, ['locked'], id)),
        table([{ label: 'Token' }, { label: 'Result' }, { label: 'Nitro' }, { label: 'Free slots', num: true }, { label: 'Lock' }, { label: 'Age' }],
          r.rows.map((x) => el('tr', {},
            el('td', { class: 'rs-mono', text: x.token || '—' }), el('td', {}, pill(x.status)),
            el('td', { class: 'rs-muted', text: x.nitro ? (x.nitroDays != null ? `${x.nitroDays}d left` : 'yes') : '—' }),
            el('td', { class: 'num', text: x.boostFree == null ? '—' : x.boostFree }),
            el('td', { class: 'rs-muted', text: x.lockType || '—' }),
            el('td', { class: 'rs-muted', text: x.ageDays == null ? '—' : `${x.ageDays}d` }))), 'No result.'),
        r.total > r.rows.length ? el('p', { class: 'rs-muted', text: `Showing the ${r.rows.length} first of ${num(r.total)} (problems first).` }) : null);
    }

    function showProgress(c) {
      const pct = c.total ? Math.min(100, Math.round(((c.checked || 0) / c.total) * 100)) : 0;
      host.replaceChildren(
        el('div', { class: 'rs-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` })),
        el('p', { class: 'rs-muted', text: `${num(c.checked || 0)} of ${num(c.total)} checked…` }));
    }

    async function tick(id) {
      const { check } = await api(`/reseller/stock/check/${id}`);
      if (check.status === 'running') return showProgress(check);
      stopCheckPoll();
      if (check.status === 'completed') return showResults(id);
      host.replaceChildren(el('div', { class: 'rs-note warn', text: 'The check did not finish (Salta7 restarted or timed out). Nothing was charged — run it again.' }));
    }
    function watch(id) {
      stopCheckPoll();
      showProgress({ total: 0, checked: 0 });
      tick(id).catch((e) => toast(e.message, 'error'));
      checkTimer = setInterval(() => {
        if (!$('#tab-files')?.classList.contains('active')) return stopCheckPoll();
        tick(id).catch(() => {});
      }, 3000);
    }

    // resume / show the latest check when the tab opens
    api('/reseller/stock/check').then(({ check }) => {
      if (!check) return;
      if (check.status === 'running') return watch(check.id);
      if (purgedCheck && purgedCheck.id === check.id) {
        return host.replaceChildren(el('div', { class: 'rs-note', text: `${purgedCheck.deleted} token${purgedCheck.deleted === 1 ? '' : 's'} deleted from your stock. Run a new check to refresh the picture.` }));
      }
      if (check.status === 'completed') showResults(check.id).catch(() => {});
    }).catch(() => {});

    return card('Token checker', `Free. Tests your unused tokens (up to 1,000 at a time): valid, locked, Nitro, free boost slots.`,
      el('div', { class: 'rs-actions' }, startBtn), host);
  }

  /* ------------------------------ Joiner ------------------------------- */
  let joinTimer = null;
  function stopJoinPoll() { clearInterval(joinTimer); joinTimer = null; }

  async function renderJoiner() {
    stopJoinPoll();
    const d = await api('/reseller/joiner');
    const running = d.jobs.find((j) => j.status === 'running');
    const maxN = Math.max(1, Math.min(d.maxPerJoin, d.stockUnused));
    const invite = input({ type: 'text', placeholder: 'discord.gg/yourserver', maxlength: 80, autocomplete: 'off', spellcheck: 'false' });
    const count = input({ type: 'number', min: 1, max: maxN, value: Math.min(10, maxN) });
    const detail = el('div');
    const worst = () => Math.max(0, Number(count.value) || 0) * d.captchaCost;
    const cost = el('small', { class: 'rs-muted', text: '' });
    const drawCost = () => { cost.textContent = d.captchaCost > 0 ? `Worst case ${usd(worst())} (${usd(d.captchaCost)} per captcha, only charged when one is solved). Wallet: ${usd(d.balance)}.` : 'No captcha fee.'; };
    count.addEventListener('input', drawCost); drawCost();

    async function showJob(id) {
      const { job } = await api(`/reseller/joiner/${id}`);
      const pct = job.requested ? Math.round((job.joined / job.requested) * 100) : 0;
      detail.replaceChildren(card(`Join ${job.invite}`, `${num(job.joined)} of ${num(job.requested)} accounts joined`,
        el('div', { class: 'rs-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` })),
        el('div', { class: 'rs-actions' }, pill(job.status), el('span', { class: 'rs-muted', text: job.cost > 0 ? `Charged ${usd(job.cost)}` : 'Nothing charged' })),
        table([{ label: 'Account' }, { label: 'Result' }, { label: 'Captcha' }],
          (job.items || []).map((i) => el('tr', {}, el('td', { class: 'rs-mono', text: i.token || '—' }), el('td', {}, pill(i.status)), el('td', { class: 'rs-muted', text: i.captcha ? 'yes' : 'no' }))),
          job.status === 'running' ? 'Waiting for the first results…' : 'No per-account result.')));
      if (job.status !== 'running') { stopJoinPoll(); await refreshMe(); }
    }
    function watch(id) {
      stopJoinPoll();
      showJob(id).catch((e) => toast(e.message, 'error'));
      joinTimer = setInterval(() => {
        if (!$('#tab-joiner')?.classList.contains('active')) return stopJoinPoll();
        showJob(id).catch(() => {});
      }, 6000);
    }

    panel('joiner').replaceChildren(
      ...title('Joiner', 'Make accounts from your own stock join a server. They are not consumed — no boost is applied.'),
      el('div', { class: 'rs-grid rs-g3' }, kpi('Tokens in stock', num(d.stockUnused), 'available to join'), kpi('Max per join', num(d.maxPerJoin), 'accounts at once'), kpi('Wallet', usd(d.balance), 'covers captcha fees')),
      d.stockUnused === 0 ? el('div', { class: 'rs-note warn', text: 'Your stock is empty — add tokens in Files first.' }) : null,
      card('New join', 'Paste the server invite and choose how many of your accounts should join.',
        el('div', { class: 'rs-row' }, field('Server invite', invite, 'Link or code'), field('Accounts', count, `1–${maxN}`),
          btn('Start join', async () => {
            const r = await api('/reseller/joiner', { method: 'POST', body: { invite: invite.value, count: Number(count.value) } });
            toast(r.message); await refreshMe(); await renderJoiner();
          }, 'btn-primary')),
        cost),
      detail,
      card('Recent joins', 'Newest 15', table(
        [{ label: 'When' }, { label: 'Server' }, { label: 'Joined', num: true }, { label: 'Cost', num: true }, { label: 'Status' }, { label: '' }],
        d.jobs.map((j) => el('tr', {},
          el('td', { class: 'rs-muted', text: ago(j.createdAt) }), el('td', { class: 'rs-mono', text: j.invite }),
          el('td', { class: 'num', text: `${j.joined}/${j.requested}` }), el('td', { class: 'num', text: usd(j.cost) }), el('td', {}, pill(j.status)),
          el('td', { class: 'rs-act' }, btn('Details', () => showJob(j.id))))),
        'No join yet.')));
    if (running) watch(running.id);
  }

  /* ------------------------------- Keys -------------------------------- */
  async function renderKeys() {
    const [{ keys }] = await Promise.all([api('/reseller/keys'), refreshMe()]);
    S.keys = keys;
    const boosts = input({ type: 'number', min: 1, max: 1000, value: 14 });
    const count = input({ type: 'number', min: 1, max: 500, value: 10 });
    const note = input({ type: 'text', maxlength: 120, placeholder: 'Optional — customer, order…' });
    const out = el('textarea', { class: 'rs-input rs-mono', readonly: true, rows: 5 });
    const outBox = el('div', { class: 'rs-out rs-hidden' }, out,
      el('div', { class: 'rs-actions' }, btn('Copy all', () => copy(out.value, 'Keys copied')), btn('Download .txt', () => download('keys.txt', out.value))));
    const listHost = el('div');
    const summary = el('span', { class: 'rs-muted' });
    const search = input({ type: 'search', placeholder: 'Search key, note or server…', oninput: () => { S.q = search.value.toLowerCase(); draw(); } });
    const seg = el('div', { class: 'rs-seg', role: 'group', 'aria-label': 'Filter keys' });
    [['all', 'All'], ['unused', 'Unused'], ['redeemed', 'Redeemed']].forEach(([id, label]) =>
      seg.append(el('button', { type: 'button', 'aria-pressed': String(S.filter === id), text: label, onclick: () => {
        S.filter = id; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === label))); draw();
      } })));

    async function reload() { S.keys = (await api('/reseller/keys')).keys; await refreshMe(); draw(); }
    function draw() {
      const shown = S.keys.filter((k) =>
        (S.filter === 'all' || (S.filter === 'unused' && !k.redeemed) || (S.filter === 'redeemed' && k.redeemed)) &&
        (!S.q || `${k.code} ${k.note} ${k.serverLink || ''} ${k.server || ''}`.toLowerCase().includes(S.q)));
      summary.textContent = `${num(shown.length)} shown · ${num(S.keys.filter((k) => !k.redeemed).length)} unused of ${num(S.keys.length)}`;
      listHost.replaceChildren(table(
        [{ label: 'Key' }, { label: 'Boosts', num: true }, { label: 'Status' }, { label: 'Note / server' }, { label: 'Created' }, { label: '' }],
        shown.slice(0, 300).map((k) => el('tr', {},
          el('td', { class: 'rs-mono', text: k.code }),
          el('td', { class: 'num', text: k.redeemed ? `${k.delivered}/${k.boosts}` : k.boosts }),
          el('td', {}, pill(k.redeemed ? 'redeemed' : 'unused')),
          el('td', { class: 'rs-muted', text: k.server || k.serverLink || k.note || '—' }),
          el('td', { class: 'rs-muted', text: ago(k.createdAt) }),
          el('td', { class: 'rs-act' },
            btn('Copy', () => copy(k.code, 'Key copied')),
            btn('Delete', async () => { await api(`/reseller/keys/${encodeURIComponent(k.code)}`, { method: 'DELETE' }); await reload(); }, 'btn-ghost btn-mini rs-danger')))),
        'No key matches.'),
      shown.length > 300 ? el('p', { class: 'rs-muted', text: `Showing the first 300 of ${num(shown.length)} — use search or filters.` }) : null);
    }
    const unusedCodes = () => S.keys.filter((k) => !k.redeemed).map((k) => k.code);
    const bulk = (scope, label) => btn(label, async () => {
      if (!confirm(`${label}? This cannot be undone.`)) return;
      await api(`/reseller/keys?scope=${scope}`, { method: 'DELETE' }); toast(label); await reload();
    }, 'btn-ghost btn-mini rs-danger');

    const need = S.me.stock.tokensNeeded, have = S.me.stock.unused;
    panel('keys').replaceChildren(
      ...title('Keys', 'Generate keys for your customers. Each one is redeemed on your page with your stock.'),
      need > have ? el('div', { class: 'rs-note warn', text: `Your unused keys need ${num(need)} tokens but you only have ${num(have)} — add stock in Files.` }) : null,
      Number(S.me.boostPrice) > 0 ? el('div', { class: 'rs-note', text: `Each delivered boost costs ${usd(S.me.boostPrice)} from your balance (${usd(S.me.balance)} left).` }) : null,
      card('Generate keys', null,
        el('div', { class: 'rs-row' }, field('Boosts per key', boosts), field('How many', count), field('Note', note),
          btn('Generate', async () => {
            const r = await api('/reseller/keys', { method: 'POST', body: { boosts: Number(boosts.value), count: Number(count.value), note: note.value } });
            out.value = r.keys.map((k) => k.code).join('\n'); outBox.classList.remove('rs-hidden'); toast(r.message); await reload();
          }, 'btn-primary')),
        outBox),
      card('All keys', null,
        el('div', { class: 'rs-toolbar' }, seg, search, summary),
        el('div', { class: 'rs-actions' },
          btn('Copy unused', () => { const c = unusedCodes(); if (!c.length) throw new Error('No unused key'); return copy(c.join('\n'), `${c.length} keys copied`); }),
          btn('Export unused', () => { const c = unusedCodes(); if (!c.length) throw new Error('No unused key'); download('unused-keys.txt', c.join('\n')); }),
          bulk('redeemed', 'Delete redeemed'), bulk('unused', 'Delete unused')),
        listHost));
    draw();
  }

  /* -------------------------------- API -------------------------------- */
  /* ------------------------ SellAuth dynamic delivery ------------------------ */
  function sellauthCard(sa, reload) {
    const url = sa.ref ? `${location.origin}/api/sellauth/r/${sa.ref}` : '';
    const secret = input({ type: 'password', autocomplete: 'off', placeholder: sa.secretSet ? '•••••••• (saved — type to replace)' : 'Paste your SellAuth webhook secret' });
    const def = input({ type: 'number', min: 0, max: 1000, value: sa.defaultBoosts || '', placeholder: 'None' });
    const sid = input({ type: 'text', placeholder: 'Product or variant ID', maxlength: 64 });
    const slabel = input({ type: 'text', placeholder: 'Label (optional)', maxlength: 80 });
    const sboosts = input({ type: 'number', min: 1, placeholder: 'Boosts' });
    const step = (...c) => el('li', {}, el('span', {}, ...c));

    const setup = !sa.ref
      ? el('div', { class: 'rs-note' }, el('span', { text: 'Create your private webhook address first. It is yours only: keys it delivers go to your key list and use your stock.' }),
        btn('Create my webhook address', async () => { await api('/reseller/sellauth/enable', { method: 'POST' }); await reload(); }, 'btn-primary btn-mini'))
      : el('div', { class: 'rs-out' },
        field('Webhook URL', el('div', { class: 'rs-copy' }, input({ type: 'text', readonly: true, value: url, class: 'rs-input rs-mono' }),
          btn('Copy', () => copy(url, 'URL copied'), 'btn-primary btn-mini'),
          btn('New address', async () => {
            if (!confirm('Create a new address? The current one stops working — update it in SellAuth.')) return;
            await api('/reseller/sellauth/enable', { method: 'POST' }); await reload();
          }, 'btn-ghost btn-mini rs-danger')), 'Add ?boosts=14 to fix the amount of a product right in its URL.'),
        el('div', { class: 'rs-row' }, field('Webhook secret', secret), field('Fallback boosts', def, 'Used when nothing else matches'),
          btn('Save', async () => {
            const body = { defaultBoosts: Number(def.value || 0) };
            if (secret.value.trim()) body.webhookSecret = secret.value.trim();
            const r = await api('/reseller/sellauth', { method: 'PATCH', body }); toast(r.message); await reload();
          }, 'btn-primary btn-mini')),
        el('span', { class: `rs-pill ${sa.secretSet ? 'ok' : 'bad'}`, text: sa.secretSet ? 'Secret configured' : 'No secret — deliveries are refused' }));

    const guide = el('ol', { class: 'rs-steps' },
      step('In SellAuth open the product → ', el('b', { text: 'Deliverables' }), ' → ', el('b', { text: 'Dynamic Delivery' }), ' and paste the webhook URL.'),
      step('Copy the secret from ', el('b', { text: 'Storefront → Configure → Miscellaneous' }), ' and save it here.'),
      step('Add a required ', el('b', { text: 'Custom Field' }), ' named ', el('code', { text: 'Server Link' }), ' so the buyer gives you their server.'),
      step('The amount comes from ', el('code', { text: '?boosts=N' }), ', then from a product link below, then from “14 Boosts” in the name, then the fallback.'));

    const links = el('div', { class: 'rs-out' },
      el('div', { class: 'rs-row' }, field('SellAuth ID', sid), field('Label', slabel), field('Boosts', sboosts),
        btn('Link', async () => {
          await api('/reseller/sellauth/products', { method: 'POST', body: { sellauthId: sid.value, label: slabel.value, boosts: Number(sboosts.value) } });
          toast('Product linked'); await reload();
        }, 'btn-primary btn-mini')),
      table([{ label: 'ID' }, { label: 'Label' }, { label: 'Boosts', num: true }, { label: '' }],
        sa.products.map((p) => el('tr', {}, el('td', { class: 'rs-mono', text: p.sellauthId }), el('td', { text: p.label || '—' }), el('td', { class: 'num', text: p.boosts }),
          el('td', { class: 'rs-act' }, btn('Remove', async () => { await api(`/reseller/sellauth/products/${p.id}`, { method: 'DELETE' }); await reload(); }, 'btn-ghost btn-mini rs-danger')))),
        'No product link yet.'));

    const rows = sa.deliveries.map((d) => {
      const detail = el('pre', { class: 'rs-code rs-hidden', text: JSON.stringify(d.payload ?? {}, null, 2) });
      return el('tr', {},
        el('td', { class: 'rs-muted', text: ago(d.createdAt) }), el('td', { class: 'rs-mono', text: d.invoiceId || '—' }), el('td', { text: d.product || '—' }),
        el('td', { class: 'num', text: d.boosts ?? '—' }), el('td', { class: 'rs-mono', text: d.key || '—' }),
        el('td', { class: 'rs-mono', text: d.serverLink || '—' }),
        el('td', {}, pill(d.status), d.status === 'error' ? el('div', {}, el('span', { class: 'rs-muted', text: ` ${d.error || ''} ` }),
          btn('Payload', () => detail.classList.toggle('rs-hidden'), 'btn-ghost btn-mini'), detail) : null));
    });
    const log = table([{ label: 'When' }, { label: 'Invoice' }, { label: 'Product' }, { label: 'Boosts', num: true }, { label: 'Key' }, { label: 'Server' }, { label: 'Result' }], rows, 'No delivery yet — place a test order.');

    return el('div', { class: 'rs-out' },
      card('SellAuth dynamic delivery', 'Sell your keys on your own SellAuth shop: every order gets a fresh key automatically.', setup, guide),
      sa.ref ? card('Product links', 'Match a SellAuth product or variant ID to a number of boosts.', links) : null,
      sa.ref ? card('Deliveries', 'Latest 50 orders. A failed one shows what SellAuth sent, so you know which ID to link.', log) : null);
  }

  async function renderApi() {
    await refreshMe();
    const base = `${location.origin}/api/v1`;
    const shown = el('div');
    const hasKey = Boolean(S.me.api.prefix);
    let saNode;
    try { saNode = sellauthCard(await api('/reseller/sellauth'), renderApi); }
    catch (e) { saNode = el('div', { class: 'rs-note warn', text: `SellAuth delivery unavailable: ${e.message}. Ask the admin to run db/migration_resellers.sql.` }); }
    const sample = (t) => el('pre', { class: 'rs-code', text: t });

    async function makeKey() {
      if (hasKey && !confirm('Create a new API key? The current one stops working immediately.')) return;
      const r = await api('/reseller/api-key', { method: 'POST' });
      shown.replaceChildren(el('div', { class: 'rs-note' }, el('b', { text: 'Copy your key now — it will not be shown again.' }),
        el('div', { class: 'rs-copy' }, input({ type: 'text', readonly: true, value: r.key, class: 'rs-input rs-mono' }), btn('Copy', () => copy(r.key, 'API key copied'), 'btn-primary btn-mini'))));
      await refreshMe();
      status.textContent = `Active key: ${S.me.api.prefix}…`;
    }
    const status = el('p', { class: 'rs-muted', text: hasKey ? `Active key: ${S.me.api.prefix}…` : 'No API key yet.' });

    panel('api').replaceChildren(
      ...title('API', 'Create keys and read your stock from your own scripts or shop.'),
      card('API key', 'Sent as a Bearer token. Only its fingerprint is stored on our side.', status, shown,
        el('div', { class: 'rs-actions' }, btn(hasKey ? 'Regenerate key' : 'Create API key', makeKey, 'btn-primary btn-mini'),
          hasKey ? btn('Revoke', async () => { if (!confirm('Revoke your API key?')) return; await api('/reseller/api-key', { method: 'DELETE' }); toast('API key revoked'); await renderApi(); }, 'btn-ghost btn-mini rs-danger') : null)),
      saNode,
      card('Endpoints', `Base URL: ${base}`,
        table([{ label: 'Method' }, { label: 'Path' }, { label: 'What it does' }], [
          ['GET', '/me', 'Balance, stock and key totals'],
          ['GET', '/stock', 'Unused / used tokens'],
          ['POST', '/stock', 'Add tokens — { "tokens": ["…"] }'],
          ['POST', '/keys', 'Create keys — { "boosts": 14, "count": 1, "note": "" }'],
          ['GET', '/keys?status=unused', 'List your keys (unused | redeemed)'],
          ['GET', '/keys/:code', 'Status and progress of one key'],
          ['DELETE', '/keys/:code', 'Delete an unused key'],
        ].map(([m, p, w]) => el('tr', {}, el('td', {}, el('span', { class: 'rs-pill brand', text: m })), el('td', { class: 'rs-mono', text: p }), el('td', { class: 'rs-muted', text: w }))), '')),
      card('Example', null,
        sample(`curl -X POST ${base}/keys \\\n  -H "Authorization: Bearer nbk_your_key" \\\n  -H "Content-Type: application/json" \\\n  -d '{"boosts":14,"count":1}'`),
        sample('{ "keys": [ { "code": "K7Q2MZ9XA4LP03WD", "boosts": 14 } ] }')));
  }

  /* ----------------------------- Orders (keys) ------------------------- */
  async function renderOrders() {
    const host = $('#rs-orders');
    if (!host) return;
    const { orders } = await api('/reseller/orders');
    host.replaceChildren(card('Redeemed keys', 'Boosts started with your keys · 100 latest',
      table([{ label: 'When' }, { label: 'Key' }, { label: 'Server' }, { label: 'Boosts', num: true }, { label: 'Status' }],
        orders.map((o) => el('tr', {},
          el('td', { class: 'rs-muted', text: ago(o.createdAt) }), el('td', { class: 'rs-mono', text: o.key || '—' }),
          el('td', { class: 'rs-mono', text: o.server || '—' }), el('td', { class: 'num', text: `${o.delivered}/${o.requested}` }), el('td', {}, pill(o.status)))),
        'No key redeemed yet.')));
  }

  /* ---------------------------- Redeem page ---------------------------- */
  async function renderPage() {
    await refreshMe();
    const p = S.me.page;
    const slug = input({ type: 'text', maxlength: 32, value: p.slug, placeholder: 'my-shop' });
    const ttl = input({ type: 'text', maxlength: 40, value: p.title, placeholder: 'My Shop Boosts' });
    const sup = input({ type: 'url', value: p.supportUrl, placeholder: 'https://t.me/yourhandle' });
    const link = el('div', { class: 'rs-copy' });
    const drawLink = () => {
      const s = slug.value.trim().toLowerCase();
      const url = s ? `${location.origin}/r/${s}` : '';
      link.replaceChildren(input({ type: 'text', readonly: true, value: url || 'Choose a page name to get your link', class: 'rs-input rs-mono' }),
        url ? btn('Copy', () => copy(url, 'Link copied'), 'btn-ghost btn-mini') : null,
        url && p.slug ? el('a', { class: 'btn btn-ghost btn-mini', href: url, target: '_blank', rel: 'noopener', text: 'Open' }) : null);
    };
    slug.addEventListener('input', drawLink);
    drawLink();

    panel('page').replaceChildren(
      ...title('Redeem Page', 'The page your customers use to redeem the keys you sell.'),
      card('Your link', 'Only keys from your own stock work on this page.', link),
      card('Appearance', 'Shown on your page instead of the platform’s name and contact.',
        el('div', { class: 'rs-row' }, field('Page name', slug, 'Letters, numbers and dashes'), field('Title', ttl), field('Support link', sup, 'Shown if a boost fails'),
          btn('Save', async () => {
            await api('/reseller/page', { method: 'PATCH', body: { slug: slug.value, title: ttl.value, supportUrl: sup.value } });
            toast('Redeem page saved'); await refreshMe(); await renderPage();
          }, 'btn-primary'))));
  }

  /* ---------------------- Settings: password (everyone) ---------------- */
  function renderPassword() {
    const host = $('#pf-password');
    if (!host) return;
    const cur = input({ type: 'password', autocomplete: 'current-password' });
    const nw = input({ type: 'password', autocomplete: 'new-password', placeholder: '6 characters minimum' });
    host.replaceChildren(card('Change password', null,
      el('div', { class: 'rs-row' }, field('Current password', cur), field('New password', nw),
        btn('Update password', async () => {
          await api('/auth/password', { method: 'PATCH', body: { currentPassword: cur.value, newPassword: nw.value } });
          cur.value = nw.value = ''; toast('Password updated');
        }, 'btn-primary'))));
  }

  window.NBReseller = { onLogin, reset };
})();
