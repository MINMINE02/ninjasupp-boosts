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
    // c.hide = a secondary column that is dropped on phones (see reseller.css)
    rows.forEach((tr) => cols.forEach((c, i) => { if (c.hide && tr.children[i]) tr.children[i].classList.add('hide-sm'); }));
    return el('div', { class: 'rs-table' }, el('table', {},
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: [c.num ? 'num' : '', c.hide ? 'hide-sm' : ''].join(' ').trim(), text: c.label })))),
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
    $$('.nonreseller-only').forEach((n) => n.classList.toggle('hidden', on));   // “Premium” tab: only for accounts without premium
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
    stopBoostPoll();
    S.me = null;
    $$('.reseller-only, .nonreseller-only').forEach((n) => n.classList.add('hidden'));
  }

  /* --------------------- Menu drawer (3-bar button) --------------------- */
  (function menuDrawer() {
    const view = $('#app-view'), side = $('#dash-side'), toggle = $('#menu-toggle'),
      closeBtn = $('#menu-close'), backdrop = $('#drawer-backdrop'),
      bal = $('#ab-balance'), topBal = $('#top-balance');
    if (!view || !side || !toggle) return;

    const isOpen = () => view.classList.contains('menu-open');
    function setOpen(open, restoreFocus) {
      view.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        const on = side.querySelector('.acc-btn.active');
        if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
        if (closeBtn) closeBtn.focus({ preventScroll: true });
      } else if (restoreFocus) {
        toggle.focus({ preventScroll: true });
      }
    }
    toggle.addEventListener('click', () => setOpen(!isOpen()));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false, true));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setOpen(false, true); });
    // choosing a page (or Logout / Support) closes the menu
    side.addEventListener('click', (e) => { if (e.target.closest('.acc-btn')) setOpen(false); });
    // a bigger window while open (rotation…) keeps working; leaving the app view always closes it
    new MutationObserver(() => { if (view.classList.contains('hidden')) setOpen(false); })
      .observe(view, { attributes: true, attributeFilter: ['class'] });

    // the wallet shown in the top bar follows the one the app already keeps up to date
    if (bal && topBal) {
      const sync = () => { topBal.textContent = bal.textContent; };
      new MutationObserver(sync).observe(bal, { childList: true, characterData: true, subtree: true });
      sync();
    }
  })();

  const LOADERS = { boost: renderBoost, files: renderFiles, joiner: renderJoiner, checker: renderChecker, keys: renderKeys, api: renderApi, page: renderPage, history: renderOrders };
  async function load(tab) {
    const fn = LOADERS[tab];
    if (!fn || !S.me?.enabled) return;
    try { await fn(); } catch (err) { toast(err.message, 'error'); }
  }
  $$('.acc-btn[data-tab]').forEach((b) => b.addEventListener('click', () => {
    stopJoinPoll(); stopCheckPoll(); stopBoostPoll();
    b.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });   // keeps the tab visible in the phone tab bar
    if (b.dataset.tab === 'premium') renderPremium().catch((err) => toast(err.message, 'error'));
    else load(b.dataset.tab);
  }));

  const panel = (id) => $(`#tab-${id}`);
  const title = (t, sub) => [el('h1', { class: 'title', text: t }), el('p', { class: 'subtitle', text: sub })];

  /* ------------------------------ Premium ------------------------------ */
  // Upsell tab for accounts without premium. Video / title / text are set by the
  // admin (Settings → Premium tab); the server only sends embed URLs on hosts the
  // CSP allows, and they are re-checked here before being put in the page.
  const PREMIUM_FEATURES = [
    ['Joiner', 'Join your own accounts to any server.'],
    ['Checker', 'Check your tokens for free before using them.'],
    ['Files', 'Your own token stock, kept separate from everyone else.'],
    ['Keys', 'Generate redeem keys and sell them.'],
    ['API', 'Deliver automatically from SellAuth.'],
    ['Redeem Page', 'Your own branded page for your customers.'],
  ];
  const VIDEO_EMBED = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+)(\?.*)?$/;
  async function renderPremium() {
    const d = await api('/settings/premium');
    let media = null;
    if (d.video && d.video.kind === 'file' && /^https:\/\//.test(d.video.src || '')) {
      media = el('video', { class: 'pm-video', src: d.video.src, controls: true, playsinline: true, preload: 'metadata' });
    } else if (d.video && VIDEO_EMBED.test(d.video.src || '')) {
      media = el('iframe', {
        class: 'pm-video', src: d.video.src, title: d.title || 'Premium', loading: 'lazy', allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
      });
    }
    panel('premium').replaceChildren(
      ...title(d.title || 'Premium', d.text || 'Unlock the full toolkit: your own stock, keys, API and redeem page.'),
      media ? el('div', { class: 'pm-frame' }, media) : null,
      card('What you get with Premium', null,
        el('div', { class: 'pm-features' }, PREMIUM_FEATURES.map(([n, t]) => el('div', { class: 'pm-feature' }, el('b', { text: n }), el('span', { text: t }))))),
      d.supportUrl ? el('div', { class: 'rs-actions' }, el('a', { class: 'btn btn-primary', href: d.supportUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get Premium' })) : null);
  }

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

  /* ----------------------------- small helpers ------------------------------ */
  // How many distinct tokens a pasted blob holds (last ":" part of each line).
  const pasteCount = (text) => new Set(String(text || '').split(/\r?\n/).map((l) => l.trim().split(':').pop().trim()).filter(Boolean)).size;
  const SAMPLE = 'email:password:TOKEN\nTOKEN\nuser:pass:TOKEN';
  const textarea = (props) => el('textarea', { class: 'rs-input', rows: 6, spellcheck: 'false', autocomplete: 'off', placeholder: SAMPLE, ...props });

  // Segmented source switch: seg([{ id, label }], currentId, (id) => …)
  function seg(options, current, onPick) {
    const wrap = el('div', { class: 'rs-seg', role: 'group' });
    const buttons = options.map((o) => el('button', { type: 'button', 'aria-pressed': String(o.id === current), text: o.label }));
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onPick(options[i].id);
    }));
    wrap.append(...buttons);
    return wrap;
  }
  const progressBar = (pct) => el('div', { class: 'rs-progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` }));

  /* ------------------------------- Boost ------------------------------- */
  // The customer-panel Boost tab is the "paste your tokens, pay the captchas"
  // booster. For a reseller we put a switch on top: use the stock from Files.
  let boostTimer = null;
  function stopBoostPoll() { clearInterval(boostTimer); boostTimer = null; }

  async function renderBoost(resumeId) {
    stopBoostPoll();
    await refreshMe();
    const tab = panel('boost');
    $('#rs-boost')?.remove();
    const booster = tab.querySelector('.booster');
    if (!booster) return;

    const unused = S.me.stock.unused;
    const bpt = S.me.stock.boostsPerToken || 2;
    const price = Number(S.me.boostPrice) || 0;
    const maxBoosts = Math.max(0, Math.min(unused, 200) * bpt);
    let mode = sessionStorage.getItem('rs_boost_mode') || (unused > 0 ? 'stock' : 'paste');
    if (mode === 'stock' && !unused && !resumeId) mode = 'paste';

    const invite = input({ type: 'text', placeholder: 'discord.gg/yourserver', maxlength: 80, autocomplete: 'off', spellcheck: 'false' });
    const boosts = input({ type: 'number', min: bpt, max: Math.max(bpt, maxBoosts), step: 1, value: Math.min(14, maxBoosts) || bpt });
    const hint = el('small', { class: 'rs-muted' });
    const drawHint = () => {
      const n = Math.max(0, Number(boosts.value) || 0);
      hint.textContent = `${num(n)} boost${n === 1 ? '' : 's'} = ${num(Math.ceil(n / bpt))} token${Math.ceil(n / bpt) === 1 ? '' : 's'} from your stock`
        + (price > 0 ? ` · up to ${usd(n * price)} (only boosts that are delivered are charged)` : '');
    };
    boosts.addEventListener('input', drawHint); drawHint();
    const result = el('div');

    async function show(id) {
      const { job, leftover } = await api(`/reseller/boost/${id}`);
      const pct = job.requested ? Math.round((job.delivered / job.requested) * 100) : 0;
      const done = job.status !== 'running';
      result.replaceChildren(card(`Boost ${job.invite}`, `${num(job.delivered)} of ${num(job.requested)} boosts delivered`,
        progressBar(pct),
        el('div', { class: 'rs-actions' }, pill(job.status), el('span', { class: 'rs-muted', text: `${num(job.tokens)} token${job.tokens === 1 ? '' : 's'} used` })),
        done && leftover ? el('div', { class: 'rs-note warn' },
          el('span', { text: `${num(leftover.boosts)} boost${leftover.boosts === 1 ? '' : 's'} could not be delivered. They are kept on this key — redeem it again later:` }),
          el('div', { class: 'rs-copy' }, el('code', { class: 'rs-mono', text: leftover.key }), btn('Copy', () => copy(leftover.key, 'Key copied'), 'btn-ghost btn-mini'))) : null,
        done && !leftover && job.delivered < job.requested ? el('div', { class: 'rs-note warn', text: 'Some boosts were not applied (accounts without a free boost slot, invalid or locked). Run the Checker on your stock to find them.' }) : null));
      if (done) { stopBoostPoll(); await refreshMe(); }
    }
    function watch(id) {
      stopBoostPoll();
      show(id).catch((e) => toast(e.message, 'error'));
      boostTimer = setInterval(() => {
        if (!$('#tab-boost')?.classList.contains('active')) return stopBoostPoll();
        show(id).catch(() => {});
      }, 5000);
    }

    const stockPanel = el('div', { class: 'rs-out' },
      el('div', { class: 'rs-grid rs-g3' }, kpi('Tokens in stock', num(unused), 'from Files'), kpi('Boosts available', num(unused * bpt), `${bpt} per token`),
        kpi(price > 0 ? 'Price / boost' : 'Wallet', price > 0 ? usd(price) : usd(S.me.balance), price > 0 ? `wallet ${usd(S.me.balance)}` : 'no per-boost fee')),
      !unused ? el('div', { class: 'rs-note warn', text: 'Your stock is empty — add tokens in Files, or switch to “Paste tokens”.' }) : null,
      card('Boost with my stock', 'Uses tokens from Files — nothing to paste. Whatever cannot be delivered stays on a key so nothing is lost.',
        el('div', { class: 'rs-row' }, field('Server invite', invite, 'Link or code'), field('Boosts', boosts, `${bpt}–${num(Math.max(bpt, maxBoosts))}`),
          btn('Start boost', async () => {
            const r = await api('/reseller/boost', { method: 'POST', body: { invite: invite.value, boosts: Number(boosts.value) } });
            try { sessionStorage.setItem('rs_boost_last', r.job.id); } catch { /* private mode */ }
            toast(r.message); await renderBoost(r.job.id);
          }, 'btn-primary')),
        hint),
      result);
    if (!unused) stockPanel.querySelector('.btn-primary').disabled = true;

    const host = el('div', { id: 'rs-boost', class: 'rs-out' },
      seg([{ id: 'stock', label: `My stock (${num(unused)})` }, { id: 'paste', label: 'Paste tokens' }], mode, (m) => { mode = m; sessionStorage.setItem('rs_boost_mode', m); apply(); }),
      stockPanel);
    function apply() { stockPanel.classList.toggle('rs-hidden', mode !== 'stock'); booster.classList.toggle('rs-hidden', mode === 'stock'); }
    tab.insertBefore(host, tab.firstChild);
    apply();
    if (resumeId) watch(resumeId);
    else {
      // coming back to the tab while a boost is still running: pick the progress back up
      let last = null;
      try { last = sessionStorage.getItem('rs_boost_last'); } catch { /* ignore */ }
      if (last) api(`/reseller/boost/${last}`).then((r) => { if (r.job.status === 'running') watch(last); }).catch(() => {});
    }
  }

  /* --------------------------- Token checker --------------------------- */
  let checkTimer = null;
  let doneCheck = null;                          // { id, text } — replaces stale results after a purge / import
  function stopCheckPoll() { clearInterval(checkTimer); checkTimer = null; }
  const rememberPasted = (id) => { try { localStorage.setItem('rs_pasted_check', id); } catch { /* private mode */ } };
  const wasPasted = (id) => { try { return localStorage.getItem('rs_pasted_check') === id; } catch { return false; } };

  async function renderChecker() {
    stopCheckPoll();
    await refreshMe();
    panel('checker').replaceChildren(
      ...title('Checker', 'Free. Find out which tokens are valid, locked or dead — before you use them.'),
      checkerCard(S.me.stock.unused, renderChecker));
  }

  function checkerCard(unused, reload) {
    let mode = unused > 0 ? 'stock' : 'paste';
    const host = el('div', { class: 'rs-out' });
    const form = el('div', { class: 'rs-out' });
    const pasted = textarea({});
    const tally = el('small', { class: 'rs-muted' });
    pasted.addEventListener('input', () => { tally.textContent = `${pasteCount(pasted.value)} token${pasteCount(pasted.value) === 1 ? '' : 's'} pasted · max 1,000`; });

    function drawForm() {
      const go = btn(mode === 'stock' ? `Check my stock (${num(Math.min(unused, 1000))})` : 'Check pasted tokens', async () => {
        if (mode === 'paste' && !pasteCount(pasted.value)) throw new Error('Paste at least one token');
        const r = await api('/reseller/stock/check', { method: 'POST', body: mode === 'paste' ? { tokens: pasted.value } : {} });
        toast(r.message); doneCheck = null;
        if (mode === 'paste') rememberPasted(r.check.id);
        watch(r.check.id);
      }, 'btn-primary btn-mini');
      if (mode === 'stock' && !unused) go.disabled = true;
      form.replaceChildren(
        mode === 'paste' ? field('Tokens to check', pasted, 'One per line — bare token or email:pass:token') : null,
        mode === 'paste' ? tally : null,
        mode === 'stock' && !unused ? el('div', { class: 'rs-note warn', text: 'Your stock is empty — paste tokens to check them, or add stock in Files.' }) : null,
        el('div', { class: 'rs-actions' }, go));
    }

    const dead = (label, n, statuses, id) => btn(`${label} (${num(n)})`, async () => {
      if (!n) throw new Error('Nothing to delete');
      if (!confirm(`Delete ${n} ${label.toLowerCase().replace('delete ', '')} token${n > 1 ? 's' : ''} from your stock?`)) return;
      const r = await api(`/reseller/stock/check/${id}/purge`, { method: 'POST', body: { statuses } });
      doneCheck = { id, text: `${r.deleted} token${r.deleted === 1 ? '' : 's'} deleted from your stock. Run a new check to refresh the picture.` };
      toast(r.message); await reload();
    }, 'btn-ghost btn-mini rs-danger');

    async function showResults(id) {
      const r = await api(`/reseller/stock/check/${id}/results`);
      const m = r.summary;
      host.replaceChildren(
        el('div', { class: 'rs-grid rs-g3' },
          kpi('Valid', num(m.valid), `${num(m.nitro)} with Nitro`),
          kpi('Locked', num(m.locked), 'phone / email / re-verify'),
          kpi('Invalid', num(m.invalid), 'dead tokens')),
        el('p', { class: 'rs-muted', text: `${num(m.freeSlots)} free boost slot${m.freeSlots === 1 ? '' : 's'} on valid accounts · checked ${ago(r.check.finishedAt || r.check.createdAt)}${m.error ? ` · ${m.error} could not be read` : ''}` }),
        el('div', { class: 'rs-actions' },
          wasPasted(id) ? btn(`Add valid to my stock (${num(m.valid)})`, async () => {
            if (!m.valid) throw new Error('No valid token to add');
            const a = await api(`/reseller/stock/check/${id}/import`, { method: 'POST', body: { statuses: ['valid'] } });
            doneCheck = { id, text: `${a.added} valid token${a.added === 1 ? '' : 's'} added to your stock${a.alreadyInStock ? ` (${a.alreadyInStock} already there)` : ''}.` };
            toast(a.message); await reload();
          }, 'btn-primary btn-mini') : null,
          dead('Delete invalid', m.invalid, ['invalid'], id), dead('Delete locked', m.locked, ['locked'], id)),
        table([{ label: 'Token' }, { label: 'Result' }, { label: 'Nitro' }, { label: 'Free slots', num: true }, { label: 'Lock', hide: true }, { label: 'Age', hide: true }],
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
      host.replaceChildren(progressBar(pct), el('p', { class: 'rs-muted', text: `${num(c.checked || 0)} of ${num(c.total)} checked…` }));
    }
    async function tick(id) {
      const { check } = await api(`/reseller/stock/check/${id}`);
      if (check.status === 'running') return showProgress(check);
      stopCheckPoll();
      if (check.status === 'completed') return showResults(id);
      host.replaceChildren(el('div', { class: 'rs-note warn', text: 'The check did not finish (it restarted or timed out). Nothing was charged — run it again.' }));
    }
    function watch(id) {
      stopCheckPoll();
      showProgress({ total: 0, checked: 0 });
      tick(id).catch((e) => toast(e.message, 'error'));
      checkTimer = setInterval(() => {
        if (!$('#tab-checker')?.classList.contains('active')) return stopCheckPoll();
        tick(id).catch(() => {});
      }, 3000);
    }

    // resume / show the latest check when the tab opens
    api('/reseller/stock/check').then(({ check }) => {
      if (!check) return;
      if (check.status === 'running') return watch(check.id);
      if (doneCheck && doneCheck.id === check.id) return host.replaceChildren(el('div', { class: 'rs-note', text: doneCheck.text }));
      if (check.status === 'completed') showResults(check.id).catch(() => {});
    }).catch(() => {});

    drawForm();
    return card('Token checker', 'Valid, locked, Nitro, free boost slots — up to 1,000 tokens per pass.',
      seg([{ id: 'stock', label: `My stock (${num(unused)})` }, { id: 'paste', label: 'Paste tokens' }], mode, (m) => { mode = m; drawForm(); }),
      form, host);
  }

  /* ------------------------------ Joiner ------------------------------- */
  let joinTimer = null;
  function stopJoinPoll() { clearInterval(joinTimer); joinTimer = null; }

  async function renderJoiner() {
    stopJoinPoll();
    const d = await api('/reseller/joiner');
    const running = d.jobs.find((j) => j.status === 'running');
    const maxN = Math.max(1, Math.min(d.maxPerJoin, d.stockUnused));
    let mode = d.stockUnused > 0 ? 'stock' : 'paste';
    const invite = input({ type: 'text', placeholder: 'discord.gg/yourserver', maxlength: 80, autocomplete: 'off', spellcheck: 'false' });
    const count = input({ type: 'number', min: 1, max: maxN, value: Math.min(10, maxN) });
    const pasted = textarea({});
    const save = el('input', { type: 'checkbox' });
    const tally = el('small', { class: 'rs-muted' });
    const cost = el('small', { class: 'rs-muted' });
    const detail = el('div');
    const form = el('div', { class: 'rs-out' });

    const accounts = () => (mode === 'paste' ? pasteCount(pasted.value) : Number(count.value) || 0);
    const drawCost = () => {
      const n = pasteCount(pasted.value);
      tally.textContent = `${n} token${n === 1 ? '' : 's'} pasted · max ${d.maxPerJoin} per join`;
      cost.textContent = d.captchaCost > 0 ? `Worst case ${usd(accounts() * d.captchaCost)} (${usd(d.captchaCost)} per captcha, only charged when one is solved). Wallet: ${usd(d.balance)}.` : 'No captcha fee.';
    };
    count.addEventListener('input', drawCost); pasted.addEventListener('input', drawCost);

    function drawForm() {
      const go = btn('Start join', async () => {
        const body = mode === 'paste'
          ? { invite: invite.value, tokens: pasted.value, save: save.checked }
          : { invite: invite.value, count: Number(count.value) };
        const r = await api('/reseller/joiner', { method: 'POST', body });
        toast(r.message); await refreshMe(); await renderJoiner();
      }, 'btn-primary');
      if (mode === 'stock' && !d.stockUnused) go.disabled = true;
      form.replaceChildren(
        el('div', { class: 'rs-row' }, field('Server invite', invite, 'Link or code'), mode === 'stock' ? field('Accounts', count, `1–${maxN}`) : null),
        mode === 'paste' ? field('Tokens', pasted, 'One per line — bare token or email:pass:token. Used for this join only.') : null,
        mode === 'paste' ? el('label', { class: 'rs-check' }, save, el('span', { text: 'Also add these tokens to my stock (Files)' })) : null,
        mode === 'paste' ? tally : null,
        mode === 'stock' && !d.stockUnused ? el('div', { class: 'rs-note warn', text: 'Your stock is empty — paste tokens instead, or add some in Files.' }) : null,
        cost, el('div', { class: 'rs-actions' }, go));
      drawCost();
    }

    async function showJob(id) {
      const { job } = await api(`/reseller/joiner/${id}`);
      const pct = job.requested ? Math.round((job.joined / job.requested) * 100) : 0;
      detail.replaceChildren(card(`Join ${job.invite}`, `${num(job.joined)} of ${num(job.requested)} accounts joined`,
        progressBar(pct),
        el('div', { class: 'rs-actions' }, pill(job.status), el('span', { class: 'rs-muted', text: job.cost > 0 ? `Charged ${usd(job.cost)}` : 'Nothing charged' })),
        table([{ label: 'Account' }, { label: 'Result' }, { label: 'Captcha', hide: true }],
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
      ...title('Joiner', 'Make accounts join a server — from your stock, or tokens you paste right here. No boost is applied.'),
      el('div', { class: 'rs-grid rs-g3' }, kpi('Tokens in stock', num(d.stockUnused), 'available to join'), kpi('Max per join', num(d.maxPerJoin), 'accounts at once'), kpi('Wallet', usd(d.balance), 'covers captcha fees')),
      card('New join', 'Paste the server invite, then pick where the accounts come from.',
        seg([{ id: 'stock', label: `My stock (${num(d.stockUnused)})` }, { id: 'paste', label: 'Paste tokens' }], mode, (m) => { mode = m; drawForm(); }),
        form),
      detail,
      card('Recent joins', 'Newest 15', table(
        [{ label: 'When' }, { label: 'Server' }, { label: 'Joined', num: true }, { label: 'Cost', num: true, hide: true }, { label: 'Status' }, { label: '' }],
        d.jobs.map((j) => el('tr', {},
          el('td', { class: 'rs-muted', text: ago(j.createdAt) }), el('td', { class: 'rs-mono', text: j.invite }),
          el('td', { class: 'num', text: `${j.joined}/${j.requested}` }), el('td', { class: 'num', text: usd(j.cost) }), el('td', {}, pill(j.status)),
          el('td', { class: 'rs-act' }, btn('Details', () => showJob(j.id))))),
        'No join yet.')));
    drawForm();
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
    const mode = el('select', { class: 'rs-input', 'aria-label': 'Delivery mode' },
      el('option', { value: 'direct', text: 'Boost the server directly' }), el('option', { value: 'key', text: 'Send a key' }));
    mode.value = sa.deliveryMode || 'direct';

    const setup = !sa.ref
      ? el('div', { class: 'rs-note' }, el('span', { text: 'Create your private webhook address first. It is yours only: keys it delivers go to your key list and use your stock.' }),
        btn('Create my webhook address', async () => { await api('/reseller/sellauth/enable', { method: 'POST' }); await reload(); }, 'btn-primary btn-mini'))
      : el('div', { class: 'rs-out' },
        field('Webhook URL', el('div', { class: 'rs-copy' }, input({ type: 'text', readonly: true, value: url, class: 'rs-input rs-mono' }),
          btn('Copy', () => copy(url, 'URL copied'), 'btn-primary btn-mini'),
          btn('New address', async () => {
            if (!confirm('Create a new address? The current one stops working — update it in SellAuth.')) return;
            await api('/reseller/sellauth/enable', { method: 'POST' }); await reload();
          }, 'btn-ghost btn-mini rs-danger')), 'Add ?boosts=14 to fix the amount of a product in its URL, and ?mode=key / ?mode=direct to choose per product.'),
        el('div', { class: 'rs-row' }, field('Webhook secret', secret), field('Fallback boosts', def, 'Used when nothing else matches'),
          field('On each order', mode, sa.modeSupported === false ? 'Saving this is temporarily unavailable; until then add ?mode=key to a product URL for keys.' : 'Direct = the server from the “Server Link” field is boosted right away'),
          btn('Save', async () => {
            const body = { defaultBoosts: Number(def.value || 0) };
            if (sa.modeSupported !== false) body.deliveryMode = mode.value;
            if (secret.value.trim()) body.webhookSecret = secret.value.trim();
            const r = await api('/reseller/sellauth', { method: 'PATCH', body }); toast(r.message); await reload();
          }, 'btn-primary btn-mini')),
        el('span', { class: `rs-pill ${sa.secretSet ? 'ok' : 'bad'}`, text: sa.secretSet ? 'Secret configured' : 'No secret — deliveries are refused' }));

    const guide = el('ol', { class: 'rs-steps' },
      step('In SellAuth open the product → ', el('b', { text: 'Deliverables' }), ' → ', el('b', { text: 'Dynamic Delivery' }), ' and paste the webhook URL.'),
      step('Copy the secret from ', el('b', { text: 'Storefront → Configure → Miscellaneous' }), ' and save it here.'),
      step('Add a required ', el('b', { text: 'Custom Field' }), ' named ', el('code', { text: 'Server Link' }), ': the buyer pastes their invite there and, in direct mode, that server is boosted immediately — no key is sent. If the link is missing or the boost cannot start (no stock / no credit), a key is sent instead.'),
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
        el('td', { class: 'num', text: d.boosts ?? '—' }),
        el('td', {}, d.direct ? el('span', { class: 'rs-pill ok', text: 'boosted directly' }) : el('span', { class: 'rs-mono', text: d.key || '—' })),
        el('td', { class: 'rs-mono', text: d.serverLink || '—' }),
        el('td', {}, d.direct && d.job ? el('span', {}, pill(d.job.jobStatus || 'running'), el('span', { class: 'rs-muted', text: ` ${d.job.delivered ?? 0}/${d.job.requested ?? d.boosts}` })) : pill(d.status),
          d.status === 'delivered' && d.error ? el('div', { class: 'rs-muted', text: d.error }) : null,
          d.status === 'error' ? el('div', {}, el('span', { class: 'rs-muted', text: ` ${d.error || ''} ` }),
            btn('Payload', () => detail.classList.toggle('rs-hidden'), 'btn-ghost btn-mini'), detail) : null));
    });
    const log = table([{ label: 'When' }, { label: 'Invoice' }, { label: 'Product' }, { label: 'Boosts', num: true }, { label: 'Key / delivery' }, { label: 'Server' }, { label: 'Result' }], rows, 'No delivery yet — place a test order.');

    return el('div', { class: 'rs-out' },
      card('SellAuth dynamic delivery', 'Sell on your own SellAuth shop: every order boosts the buyer’s server directly from the “Server Link” field (or sends a key, your choice).', setup, guide),
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
    catch (e) { saNode = el('div', { class: 'rs-note warn', text: 'SellAuth delivery is temporarily unavailable. Please contact the administrator.' }); }
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
  const DEFAULT_COLOR = '#ff2d3f';
  const PRESETS = ['#ff2d3f', '#ff7a1a', '#f5c518', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff'];
  const MAX_ICON_CHARS = 120000;

  // Any image -> small data URL (max 128px, PNG, WEBP as a fallback). Done in
  // the browser so the upload stays tiny and SVG (scriptable) is never accepted.
  function fileToIcon(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Use a PNG, JPG, WEBP or GIF image'));
      if (file.size > 5 * 1024 * 1024) return reject(new Error('Image is too big (5 MB max)'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Could not read that file'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Could not read that image'));
        img.onload = () => {
          const k = Math.min(128 / img.width, 128 / img.height, 1);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          let out = c.toDataURL('image/png');
          if (out.length > MAX_ICON_CHARS) out = c.toDataURL('image/webp', 0.85);
          if (!out.startsWith('data:image/') || out.length > MAX_ICON_CHARS) return reject(new Error('That image is too detailed — try a simpler one'));
          resolve(out);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // Any image -> JPEG/WEBP data URL no wider than `max`, small enough for the server (≤ ~300 KB).
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
            g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, c.width, c.height); // transparent areas -> dark, like the page
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

  // The card people see when they paste the page link in Discord & co.
  function embedCard(p, ctx) {
    const d = { title: p.embedTitle || '', desc: p.embedDesc || '', color: p.embedColor || '', image: p.embedImage || '', dirty: false };
    const title = input({ type: 'text', maxlength: 70, value: d.title, placeholder: 'Defaults to your page title' });
    const desc = el('textarea', { class: 'rs-input', maxlength: 300, placeholder: 'Shown under the title. Defaults to a short “redeem your key” text.' });
    desc.value = d.desc;
    const picker = el('input', { type: 'color', class: 'rs-color-pick', value: d.color || '#ff2d3f', 'aria-label': 'Embed colour' });
    const hex = input({ type: 'text', maxlength: 7, value: d.color, placeholder: 'Same as your page colour', class: 'rs-input rs-mono rs-hex', spellcheck: 'false', autocomplete: 'off' });
    const url = input({ type: 'url', placeholder: 'or paste an image link (https://…)' });
    const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'rs-hidden' });
    const prevImg = el('img', { class: 'emb-img-prev', alt: '' });

    const card_ = el('div', { class: 'emb-card' });
    const prev = el('div', { class: 'emb' }, card_, el('div', { class: 'emb-note', text: 'Preview — Discord, Telegram and X show something very close to this.' }));
    const draw = () => {
      const name = ctx.brand() || 'Ninja Boost';
      const color = d.color || ctx.color() || '#ff2d3f';
      prev.style.setProperty('--emb-color', color);
      const big = d.image;
      const thumb = !big && ctx.icon();
      card_.className = `emb-card${thumb ? ' has-thumb' : ''}`;
      card_.replaceChildren(
        el('div', { class: 'emb-site', text: name }),
        el('div', { class: 'emb-title', text: d.title || ctx.title() || name }),
        el('div', { class: 'emb-desc', text: d.desc || `Redeem your key on ${name} and boost your server in seconds.` }),
        big ? el('img', { class: 'emb-img', src: big, alt: '' }) : null,
        thumb ? el('img', { class: 'emb-thumb', src: thumb, alt: '' }) : null);
      prevImg.src = d.image || ''; prevImg.classList.toggle('hidden', !d.image);
    };
    ctx.watch(draw);
    title.addEventListener('input', () => { d.title = title.value; draw(); });
    desc.addEventListener('input', () => { d.desc = desc.value; draw(); });
    const setColor = (c, fromHex) => { d.color = c; picker.value = c || ctx.color() || '#ff2d3f'; if (!fromHex) hex.value = c; draw(); };
    picker.addEventListener('input', () => setColor(picker.value));
    hex.addEventListener('input', () => {
      const v = hex.value.trim();
      if (!v) return setColor('', true);
      const ok = window.NBTheme ? window.NBTheme.parse(v) : null;
      if (ok) setColor(ok, true);
    });
    const setImage = (v) => { d.image = v; d.dirty = true; draw(); };
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try { setImage(await fileToEmbedImage(f)); toast('Image ready — press Save embed'); } catch (err) { toast(err.message, 'error'); }
    });
    url.addEventListener('change', () => {
      const v = url.value.trim();
      if (!v) return;
      if (!/^https:\/\//i.test(v)) { toast('The image link must start with https://', 'error'); return; }
      setImage(v); url.value = '';
    });
    draw();

    return card('Link embed', 'The card shown when someone pastes your page link in Discord, Telegram or X.',
      el('div', { class: 'rs-brand-grid' },
        el('div', { class: 'emb-fields' },
          field('Embed title', title, 'Up to 70 characters'),
          field('Embed description', desc, 'Up to 300 characters'),
          el('div', { class: 'rs-field' }, el('span', { text: 'Embed colour' }),
            el('div', { class: 'rs-color-row' }, picker, hex, btn('Same as page', async () => setColor(''), 'btn-ghost btn-mini')),
            el('small', { text: 'The coloured stripe on the left of the card.' })),
          el('div', { class: 'rs-field' }, el('span', { text: 'Embed image' }),
            el('div', { class: 'emb-row' }, prevImg,
              btn('Upload image', async () => fileIn.click(), 'btn-ghost btn-mini'),
              btn('Remove', async () => setImage(''), 'btn-ghost btn-mini'), fileIn),
            url,
            el('small', { text: 'Wide images (about 2:1) look best. Without one, your page icon is used.' }))),
        el('div', { class: 'rs-field' }, el('span', { text: 'Preview' }), prev)),
      el('div', { class: 'rs-actions' },
        btn('Save embed', async () => {
          const body = { embedTitle: d.title, embedDesc: d.desc, embedColor: d.color };
          if (d.dirty) body.embedImage = d.image;
          await api('/reseller/page', { method: 'PATCH', body });
          toast('Link embed saved — Discord may take a few minutes to refresh old previews');
          await refreshMe(); await renderPage();
        }, 'btn-primary')));
  }

  async function renderPage() {
    await refreshMe();
    const p = S.me.page;
    const draft = { color: p.color || '', icon: p.icon || '', iconDirty: false };

    const slug = input({ type: 'text', maxlength: 32, value: p.slug, placeholder: 'my-shop' });
    const brand = input({ type: 'text', maxlength: 30, value: p.brand, placeholder: 'My Shop' });
    const ttl = input({ type: 'text', maxlength: 40, value: p.title, placeholder: 'My Shop Boosts' });
    const sup = input({ type: 'url', value: p.supportUrl, placeholder: 'https://discord.gg/yourinvite' });

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

    /* live preview of the customer page */
    const prevImg = el('img', { class: 'rs-prev-icon', alt: '' });
    const prevName = el('span', { class: 'rs-prev-name' });
    const prevHead = el('div', { class: 'rs-prev-head' });
    const chip = (t) => el('span', { class: 'rs-prev-chip', text: t });
    const preview = el('div', { class: 'rs-prev', 'aria-label': 'Preview of your redeem page' },
      el('div', { class: 'rs-prev-bar' }, prevImg, prevName),
      el('div', { class: 'rs-prev-body' }, prevHead,
        el('div', { class: 'rs-prev-chips' }, chip('Secure Process'), chip('Instant Activation')),
        el('div', { class: 'rs-prev-input', text: 'discord.gg/invite-code' }),
        el('span', { class: 'btn btn-primary rs-prev-btn', text: 'Start Boost' })));
    const drawPreview = () => {
      if (window.NBTheme) { if (draft.color) window.NBTheme.apply(draft.color, preview); else window.NBTheme.reset(preview); }
      prevImg.src = draft.icon || '/logo.png';
      prevName.textContent = brand.value.trim() || 'Ninja Boost';
      prevHead.textContent = ttl.value.trim() || brand.value.trim() || 'Ninja Boost';
    };
    brand.addEventListener('input', drawPreview);
    ttl.addEventListener('input', drawPreview);

    /* colour */
    const picker = el('input', { type: 'color', class: 'rs-color-pick', value: draft.color || DEFAULT_COLOR, 'aria-label': 'Pick a colour' });
    const hexIn = input({ type: 'text', maxlength: 7, value: draft.color, placeholder: `${DEFAULT_COLOR} (default)`, class: 'rs-input rs-mono rs-hex', spellcheck: 'false', autocomplete: 'off' });
    const swatches = PRESETS.map((c) => el('button', {
      type: 'button', class: 'rs-swatch', style: `background:${c}`, title: c, 'aria-label': `Use ${c}`,
      onclick: () => setColor(c),
    }));
    const markSwatches = () => swatches.forEach((n, i) => n.classList.toggle('on', PRESETS[i] === draft.color));
    function setColor(c, fromHex) {
      draft.color = c;
      picker.value = c || DEFAULT_COLOR;
      if (!fromHex) hexIn.value = c;
      markSwatches(); drawPreview();
    }
    picker.addEventListener('input', () => setColor(picker.value));
    hexIn.addEventListener('input', () => {
      const v = hexIn.value.trim();
      if (!v) return setColor('', true);
      const ok = window.NBTheme ? window.NBTheme.parse(v) : null;
      if (ok) setColor(ok, true);
    });
    const colorBox = el('div', { class: 'rs-field' }, el('span', { text: 'Page colour' }),
      el('div', { class: 'rs-color-row' }, picker, hexIn, btn('Default', () => setColor(''), 'btn-ghost btn-mini')),
      el('div', { class: 'rs-swatches' }, swatches),
      el('small', { text: 'Buttons, glows and gradients on your redeem page follow this colour.' }));

    /* icon */
    const iconImg = el('img', { class: 'rs-icon-img', alt: '' });
    const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'rs-hidden' });
    const drawIcon = () => { iconImg.src = draft.icon || '/logo.png'; drawPreview(); };
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = '';
      if (!f) return;
      try { draft.icon = await fileToIcon(f); draft.iconDirty = true; drawIcon(); toast('Icon ready — press Save'); }
      catch (err) { toast(err.message, 'error'); }
    });
    const iconBox = el('div', { class: 'rs-field' }, el('span', { text: 'Icon (top left)' }),
      el('div', { class: 'rs-icon-row' }, iconImg,
        btn('Upload image', async () => fileIn.click(), 'btn-ghost btn-mini'),
        btn('Use default', async () => { draft.icon = ''; draft.iconDirty = true; drawIcon(); }, 'btn-ghost btn-mini'), fileIn),
      el('small', { text: 'PNG, JPG, WEBP or GIF — resized to fit automatically. A square logo looks best.' }));

    drawIcon(); markSwatches();

    // the embed card follows the appearance fields when it has no value of its own
    const watchers = [];
    const ping = () => watchers.forEach((fn) => fn());
    [brand, ttl].forEach((n) => n.addEventListener('input', ping));
    const embed = embedCard(p, {
      brand: () => brand.value.trim(), title: () => ttl.value.trim(), color: () => draft.color, icon: () => draft.icon,
      watch: (fn) => watchers.push(fn),
    });
    picker.addEventListener('input', ping); hexIn.addEventListener('input', ping);
    swatches.forEach((n) => n.addEventListener('click', ping));
    fileIn.addEventListener('change', () => setTimeout(ping, 400));
    iconBox.addEventListener('click', () => setTimeout(ping, 50));

    panel('page').replaceChildren(
      ...title('Redeem Page', 'The page your customers use to redeem the keys you sell.'),
      card('Your link', 'Only keys from your own stock work on this page.', link),
      card('Appearance', 'Shown on your page instead of the platform’s name, icon and colour.',
        el('div', { class: 'rs-form-grid' },
          field('Page name', slug, 'Letters, numbers and dashes'),
          field('Name (top left)', brand, 'Next to the icon'),
          field('Title', ttl, 'Big heading of the page'),
          field('Support link', sup, 'Shown if a boost fails')),
        el('div', { class: 'rs-brand-grid' },
          el('div', { class: 'rs-brand-controls' }, colorBox, iconBox),
          el('div', { class: 'rs-field' }, el('span', { text: 'Preview' }), preview)),
        el('div', { class: 'rs-actions' },
          btn('Save', async () => {
            const body = { slug: slug.value, title: ttl.value, brand: brand.value, supportUrl: sup.value, color: draft.color };
            if (draft.iconDirty) body.icon = draft.icon;
            await api('/reseller/page', { method: 'PATCH', body });
            toast('Redeem page saved'); await refreshMe(); await renderPage();
          }, 'btn-primary'))),
      embed);
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
