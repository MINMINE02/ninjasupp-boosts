'use strict';

/* Ninja Boost — Shop page. Plain JS (the site's CSP allows scripts only from this origin).
 * Signs in with the panel's session (localStorage "db_token"); prices always come from the server. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const S = { token: null, me: null, packs: [], ready: true, tab: 'all', pack: null, method: null, order: null, poll: null, busy: false, opener: null };
  try { S.token = localStorage.getItem('db_token'); } catch { /* private mode */ }

  /* ------------------------------- helpers ------------------------------- */
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
  const usd = (n) => '$' + Number(n || 0).toFixed(2);
  const hexRgb = (h) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || ''); return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '255, 45, 63'; };
  const dateOf = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Static, trusted SVG only — never user data.
  const ICONS = {
    crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/><path d="M5 21.5h14"/>',
    coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    gem: '<path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M2 9h20M10 3L8 9l4 12 4-12-2-6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    wallet: '<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15V7"/><circle cx="16.5" cy="14" r="1.2"/>',
    ltc: '<circle cx="12" cy="12" r="9.5"/><path d="M10 6.5L8.5 15.5H15M7 12.5l6-2"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  };
  function svg(name) {
    const s = el('span', { class: 'svg-wrap', style: 'display:inline-flex' });
    s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    return s.firstChild;
  }
  const kindIcon = (k) => (k === 'premium' ? 'crown' : k === 'credits' ? 'coins' : 'gem');

  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.add('hidden'), 3800);
  }

  async function api(path, opts) {
    const o = opts || {};
    const headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    const res = await fetch('/api/shop' + path, { method: o.method || 'GET', headers, credentials: 'omit', body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401) { S.me = null; S.token = null; try { localStorage.removeItem('db_token'); } catch { /* ignore */ } renderAccount(); }
      const e = new Error(data.error || 'Something went wrong. Please try again.');
      e.status = res.status; e.data = data;
      throw e;
    }
    return data;
  }

  /* ------------------------------- account ------------------------------- */
  function renderAccount() {
    const box = $('#acct');
    if (!S.me) { box.replaceChildren(el('a', { class: 'btn-login', href: '/?next=shop', text: 'Log in' })); return; }
    const p = S.me.premium;
    const crown = el('span', { class: 'crown' + (p && p.active ? '' : ' off'), title: p && p.active ? (p.lifetime ? 'Premium · lifetime' : 'Premium until ' + dateOf(p.until)) : 'No premium yet' }, svg('crown'));
    box.replaceChildren(
      el('button', { type: 'button', class: 'chip', title: 'My orders', onclick: (e) => openOrders(e.currentTarget) }, el('span', { text: 'Orders' })),
      el('a', { class: 'chip', href: '/', title: 'Open my panel' },
        el('span', { text: S.me.username }), el('span', { class: 'bal', text: usd(S.me.balance) }), crown));
  }

  async function loadMe() {
    if (!S.token) { S.me = null; renderAccount(); return; }
    try { S.me = await api('/me'); } catch { S.me = null; }
    renderAccount();
  }

  /* -------------------------------- packs -------------------------------- */
  const TABS = [['all', 'All'], ['bundle', 'Bundles'], ['premium', 'Premium'], ['credits', 'Credits']];

  function renderSeg() {
    const seg = $('#seg');
    const count = (k) => (k === 'all' ? S.packs.length : S.packs.filter((p) => p.kind === k).length);
    const tabs = TABS.filter(([k]) => k === 'all' || count(k) > 0);
    if (tabs.length <= 2) { seg.classList.add('hidden'); return; }   // one kind only: no need for tabs
    seg.classList.remove('hidden');
    const pill = el('i', { class: 'pill' });
    seg.replaceChildren(pill, ...tabs.map(([k, label]) => el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(S.tab === k), 'data-k': k,
      onclick: () => { S.tab = k; renderSeg(); renderPacks(); },
    }, label, el('small', { text: String(count(k)) }))));
    const on = seg.querySelector('[aria-selected="true"]');
    requestAnimationFrame(() => {
      if (!on) return;
      pill.style.width = on.offsetWidth + 'px';
      pill.style.transform = `translateX(${on.offsetLeft - 5}px)`;
    });
  }

  function buyLabel(p) {
    const active = S.me && S.me.premium && S.me.premium.active;
    if (p.kind === 'credits') return 'Add credits';
    if (p.kind === 'premium') return active ? 'Extend premium' : 'Get premium';
    return active ? 'Renew + credits' : 'Get this pack';
  }

  function packCard(p, i, featured) {
    const gets = [];
    if (p.premium) gets.push(el('span', { class: 'get' }, svg('crown'), p.premium.lifetime ? 'Premium · lifetime' : `Premium · ${p.premium.days} days`));
    if (p.credits > 0) gets.push(el('span', { class: 'get' }, svg('coins'), `${usd(p.credits)} credits`));
    if (p.bonusPct > 0) gets.push(el('span', { class: 'get bonus' }, `+${p.bonusPct}% bonus`));
    let deal = null;
    if (p.premium && p.credits > 0) {
      const net = p.price - p.credits;
      deal = net > 0.005 ? `Premium effectively costs ${usd(net)}` : 'Premium is on us — you get more credits than you pay';
    }
    const amt = el('span', { class: 'amt', 'data-to': p.price.toFixed(2), text: p.price.toFixed(2) });
    const card = el('article', { class: 'pack' + (featured ? ' featured' : ''), style: `--c:${p.accent};--c-rgb:${hexRgb(p.accent)};--i:${i}`, 'data-kind': p.kind },
      el('div', { class: 'inner' },
        el('div', { class: 'shine' }),
        p.badge ? el('div', { class: 'ribbon', text: p.badge }) : null,
        el('div', { class: 'p-ico' }, svg(kindIcon(p.kind))),
        el('h3', { text: p.name }),
        el('p', { class: 'tag', text: p.tagline }),
        el('div', { class: 'price' }, el('span', { class: 'cur', text: '$' }), amt),
        el('div', { class: 'gets' }, gets),
        deal ? el('p', { class: 'deal', text: deal }) : null,
        el('ul', { class: 'feat' }, p.features.map((f) => el('li', {}, svg('check'), el('span', { text: f })))),
        el('button', { type: 'button', class: 'buy', text: buyLabel(p), onclick: (e) => openSheet(p, e.currentTarget) })));
    return { card, amt, price: p.price };
  }

  function countUp(node, to) {
    if (reduced()) { node.textContent = to.toFixed(2); return; }
    const start = performance.now();
    const dur = 900;
    const tick = (now) => {
      const k = Math.min(1, (now - start) / dur);
      node.textContent = (to * (1 - Math.pow(1 - k, 3))).toFixed(2);
      if (k < 1) requestAnimationFrame(tick);
    };
    node.textContent = '0.00';
    requestAnimationFrame(tick);
  }

  function tilt(card) {
    if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches || reduced()) return;
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--ry', ((x - 0.5) * 9).toFixed(2) + 'deg');
      card.style.setProperty('--rx', ((0.5 - y) * 9).toFixed(2) + 'deg');
      card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
    });
    card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  }

  function renderPacks() {
    const box = $('#packs');
    const list = S.tab === 'all' ? S.packs : S.packs.filter((p) => p.kind === S.tab);
    if (!S.ready || !list.length) {
      box.replaceChildren(el('div', { class: 'empty' }, el('b', { text: S.ready ? 'Nothing here yet' : 'The shop is opening soon' }), S.ready ? 'Check back in a moment.' : 'Packs will appear here as soon as they are ready.'));
      return;
    }
    const star = list.find((p) => /best|popular|top/i.test(p.badge));
    const cards = list.map((p, i) => packCard(p, i, p === star));
    box.replaceChildren(...cards.map((c) => c.card));
    cards.forEach((c) => {
      tilt(c.card);
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { io.disconnect(); countUp(c.amt, c.price); } }, { threshold: 0.4 });
        io.observe(c.card);
      } else { countUp(c.amt, c.price); }
    });
  }

  /* ------------------------------ checkout sheet ------------------------------ */
  const sheet = $('#sheet');
  const body = $('#sheet-body');
  // like replaceChildren, but skips null/false entries (replaceChildren would print them as text)
  const show = (...nodes) => body.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));

  function setAccent(p) {
    const card = $('#sheet-card');
    card.style.setProperty('--c', p.accent);
    card.style.setProperty('--c-rgb', hexRgb(p.accent));
  }

  function openSheet(p, opener) {
    S.pack = p; S.method = null; S.order = null; S.fromOrders = false; S.opener = opener || null;
    setAccent(p);
    sheet.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderChoose();
    setTimeout(() => { const f = body.querySelector('button, a'); if (f) f.focus(); }, 30);
  }

  /* ------------------------------ order history ------------------------------ */
  const ORDER_STATUS = { completed: 'Delivered', awaiting_payment: 'Waiting for payment', processing: 'Processing', cancelled: 'Expired' };
  const dateTimeOf = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const shortId = (id) => '#' + String(id || '').slice(0, 8).toUpperCase();
  const statusBadge = (st) => el('span', { class: 'ord-badge s-' + st, text: ORDER_STATUS[st] || st });

  function orderGets(o) {
    const gets = [];
    if (o.premium) gets.push(o.premium.lifetime ? 'Premium for life' : `Premium · ${o.premium.days} days`);
    if (o.credits > 0) gets.push(`${usd(o.credits)} credits`);
    return gets;
  }

  // A pack-like object rebuilt from an order, so the checkout views (head, Litecoin page…) can be reused.
  function packOfOrder(o) {
    const known = S.packs.find((p) => p.id === o.packId);
    if (known) return known;
    const kind = o.premium && o.credits > 0 ? 'bundle' : o.premium ? 'premium' : 'credits';
    return { id: o.packId, name: o.pack, kind, price: o.price, credits: o.credits, premium: o.premium, accent: '#ff2d3f', features: [] };
  }

  function openSheetShell(opener) {
    S.opener = opener || S.opener || null;
    sheet.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function setDefaultAccent() {
    const card = $('#sheet-card');
    card.style.setProperty('--c', '#ff2d3f');
    card.style.setProperty('--c-rgb', hexRgb('#ff2d3f'));
  }

  function backToOrders() {
    return el('button', { type: 'button', class: 'ord-back', onclick: () => openOrders(), 'aria-label': 'Back to my orders' }, '← My orders');
  }

  async function openOrders(opener) {
    stopPoll();
    S.pack = null; S.order = null; S.method = null;
    setDefaultAccent();
    openSheetShell(opener);
    const title = el('div', { class: 's-head' }, el('div', {}, el('h2', { id: 'sheet-title', text: 'My orders' }), el('p', { text: 'Tap an order to see all its details' })));
    show(title, el('p', { class: 'fine', text: 'Loading…' }));
    try {
      const r = await api('/orders');
      const list = r.orders || [];
      const rows = list.map((o) => el('button', { type: 'button', class: 'ord', onclick: () => openOrder(o.id) },
        el('span', { class: 'ord-l' },
          el('b', { text: o.pack }),
          el('small', { text: orderGets(o).join(' + ') || '—' }),
          el('small', { class: 'dim', text: `${dateTimeOf(o.createdAt)} · ${o.method === 'ltc' ? 'Litecoin' : 'Wallet'} · ${shortId(o.id)}` })),
        el('span', { class: 'ord-r' }, el('b', { text: usd(o.price) }), statusBadge(o.status)),
        el('span', { class: 'ord-go', 'aria-hidden': 'true', text: '›' })));
      const total = list.filter((o) => o.status === 'completed').reduce((n, o) => n + o.price, 0);
      show(title,
        list.length ? el('div', { class: 'ord-sum' }, el('span', { text: `${list.length} order${list.length > 1 ? 's' : ''}` }), el('span', { text: `Total spent ${usd(total)}` })) : null,
        list.length ? el('div', { class: 'ord-list' }, rows) : el('p', { class: 'fine', text: 'No order yet.' }));
    } catch (err) {
      show(title, el('div', { class: 'msg', text: err.message || 'Could not load your orders' }));
    }
  }

  function recapRows(rows) {
    return el('div', { class: 'recap' }, rows.filter(Boolean).map(([k, v]) => el('div', {}, el('span', { text: k }), el('b', { text: v }))));
  }

  async function openOrder(id) {
    stopPoll();
    show(backToOrders(), el('p', { class: 'fine', text: 'Loading…' }));
    let r;
    try { r = await api('/orders/' + id); }
    catch (err) { show(backToOrders(), el('div', { class: 'msg', text: err.message || 'Could not load this order' })); return; }
    const o = r.order;
    const d = r.deposit;
    const p = packOfOrder(o);
    S.pack = p; S.order = o; S.fromOrders = true;
    setAccent(p);

    // Still waiting for the Litecoin payment: bring back the payment page (address, amount, QR) and follow it live.
    if (o.status === 'awaiting_payment' && o.method === 'ltc' && d) {
      if (d.status === 'completed') { renderShort(o, d); return; }
      renderLtc({ order: o, deposit: d, qr: r.qr, missingUsd: d.usdAmount != null ? d.usdAmount : undefined }, d.received > 0 ? 2 : 1, d.received > 0 ? partialNote(d) : null);
      startPoll();
      return;
    }

    const rows = [
      ['Order', shortId(o.id)],
      ['Pack', o.pack],
      ['Price', usd(o.price)],
      o.credits > 0 ? ['Credits', '+' + usd(o.credits)] : null,
      o.premium ? ['Premium', o.premium.lifetime ? 'Lifetime' : `${o.premium.days} days`] : null,
      o.premium && o.status === 'completed' ? ['Premium until', o.premiumUntil ? dateOf(o.premiumUntil) : 'Lifetime'] : null,
      ['Paid with', o.method === 'ltc' ? 'Litecoin' : 'Wallet credits'],
      ['Ordered', dateTimeOf(o.createdAt)],
      o.completedAt ? ['Delivered', dateTimeOf(o.completedAt)] : null,
    ];
    const nodes = [backToOrders(), head(p),
      el('div', { class: 's-total' }, statusBadge(o.status), el('b', { text: usd(o.price) })),
      recapRows(rows)];

    if (d) {
      nodes.push(el('div', { class: 's-label', text: 'Litecoin payment' }),
        recapRows([
          ['Amount', d.ltcAmount != null ? d.ltcAmount + ' LTC' : null],
          ['Value', d.usdAmount != null ? usd(d.usdAmount) : null],
          ['Received', d.received != null ? `${d.received} LTC${d.receivedUsd != null ? ' (' + usd(d.receivedUsd) + ')' : ''}` : null],
        ].map((x) => (x[1] ? x : null))),
        d.address ? copyRow('Address', d.address) : null,
        d.txId ? copyRow('Transaction ID', d.txId) : null);
    }
    if (o.status === 'cancelled') nodes.push(el('div', { class: 'msg', text: 'This order expired before the payment arrived. If you paid anyway, the money is in your wallet.' }));
    nodes.push(el('button', { type: 'button', class: 'cta ghost', onclick: closeSheet, text: 'Close' }));
    show(...nodes);
  }

  function closeSheet() {
    stopPoll();
    sheet.classList.add('hidden');
    document.body.style.overflow = '';
    if (S.opener && document.contains(S.opener)) S.opener.focus();
  }

  function head(p) {
    const gets = [];
    if (p.premium) gets.push(p.premium.lifetime ? 'Premium for life' : `Premium · ${p.premium.days} days`);
    if (p.credits > 0) gets.push(`${usd(p.credits)} credits`);
    return el('div', { class: 's-head' }, el('div', { class: 'p-ico' }, svg(kindIcon(p.kind))),
      el('div', {}, el('h2', { id: 'sheet-title', text: p.name }), el('p', { text: gets.join(' + ') })));
  }

  function renderChoose(errText) {
    const p = S.pack;
    const nodes = [head(p), el('div', { class: 's-total' }, el('span', { text: 'Total' }), el('b', { text: usd(p.price) }))];

    if (!S.me) {
      nodes.push(el('div', { class: 'msg info', text: 'Log in to your account to buy this pack — your purchase is added to it.' }),
        el('a', { class: 'cta', href: '/?next=shop', style: 'display:block;text-align:center;text-decoration:none', text: 'Log in to continue' }));
      show(...nodes);
      return;
    }

    const bal = S.me.balance;
    const creditsOnly = !p.premium;            // credits-only pack: can't be paid with credits
    const enough = !creditsOnly && bal + 1e-9 >= p.price;
    const ltcOn = S.me.topupEnabled;
    if (creditsOnly && S.method === 'wallet') S.method = null;
    if (!S.method) S.method = enough ? 'wallet' : ltcOn ? 'ltc' : null;
    const ltcAmt = S.me.ltcRate ? (p.price / S.me.ltcRate).toFixed(5) : null;

    const method = (id, icon, title, sub, disabled) => el('button', {
      type: 'button', class: 'method', role: 'radio', 'aria-checked': String(S.method === id), disabled: disabled ? true : null,
      onclick: () => { S.method = id; renderChoose(); },
    }, el('span', { class: 'm-ico' }, svg(icon)), el('span', { class: 'm-t' }, el('b', { text: title }), el('small', { text: sub })), el('span', { class: 'm-dot' }));

    nodes.push(el('div', { class: 's-label', text: 'Pay with' }),
      el('div', { role: 'radiogroup', 'aria-label': 'Payment method' },
        method('wallet', 'wallet', 'Wallet credits', creditsOnly ? 'Not available for credit packs · Litecoin only' : enough ? `Balance ${usd(bal)} · instant` : `Balance ${usd(bal)} · ${usd(p.price - bal)} short`, !enough),
        method('ltc', 'ltc', 'Litecoin', ltcOn ? (ltcAmt ? `≈ ${ltcAmt} LTC · confirmed in minutes` : 'Pay with LTC · confirmed in minutes') : 'Not available right now', !ltcOn)));
    if (errText) nodes.push(el('div', { class: 'msg', text: errText }));
    nodes.push(el('button', { type: 'button', class: 'cta', id: 'pay', disabled: S.method ? null : true, onclick: pay, text: S.method === 'ltc' ? `Continue · ${usd(p.price)}` : `Pay ${usd(p.price)}` }),
      el('p', { class: 'fine', text: 'Delivered to your account the moment payment is confirmed.' }));
    show(...nodes);
  }

  async function pay() {
    if (S.busy || !S.method) return;
    S.busy = true;
    const btn = $('#pay');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    try {
      const r = await api('/checkout', { method: 'POST', body: { packId: S.pack.id, method: S.method } });
      if (S.method === 'wallet') { await loadMe(); renderSuccess(r); }
      else { S.order = r.order; renderLtc(r); startPoll(); }
    } catch (err) {
      renderChoose(err.message);
    } finally { S.busy = false; }
  }

  /* ------------------------------- Litecoin ------------------------------- */
  function copyRow(label, value) {
    return el('button', {
      type: 'button', class: 'copy', onclick: async () => {
        try { await navigator.clipboard.writeText(String(value)); toast(label + ' copied'); } catch { toast('Press and hold to copy', true); }
      },
    }, el('span', { class: 'l' }, el('small', { text: label }), el('code', { text: String(value) })), el('span', { class: 'ci' }, svg('copy')));
  }

  function stepsEl(stage) {
    const names = ['Waiting for payment', 'Confirming', 'Delivered'];
    return el('ol', { class: 'steps', style: 'padding:0' }, names.map((n, i) => el('li', { class: i + 1 < stage ? 'done' : i + 1 === stage ? 'on' : '' }, el('i'), n)));
  }

  function renderLtc(r, stage, note) {
    const p = S.pack;
    const dep = r.deposit || {};
    const pay = el('div', { class: 'pay' },
      r.qr ? el('div', { class: 'qr' }, el('img', { src: r.qr, alt: 'Litecoin payment QR code', width: 190, height: 190 })) : null,
      copyRow('Amount (LTC)', dep.ltcAmount != null ? dep.ltcAmount : ''),
      copyRow('Address', dep.address || ''),
      dep.paymentUri ? el('a', { class: 'open-wallet', href: dep.paymentUri, text: 'Open in my wallet app →' }) : null,
      stepsEl(stage || 1),
      note ? el('div', { class: 'msg info', text: note }) : null,
      el('p', { class: 'fine', text: 'Send exactly this amount to this address. This window updates by itself — you can keep it open.' }));
    show(S.fromOrders ? backToOrders() : null, head(p), el('div', { class: 's-total' }, el('span', { text: `Pay ${usd(r.missingUsd != null ? r.missingUsd : p.price)} in Litecoin` }), el('b', { text: usd(r.missingUsd != null ? r.missingUsd : p.price) })), pay);
    S.ltcView = r;
  }

  // A payment that arrived but does not cover the whole order yet: tell exactly what is left to send.
  function partialNote(d) {
    const rem = d.ltcAmount != null ? Math.max(0, d.ltcAmount - d.received) : null;
    const left = d.missingUsd != null ? d.missingUsd : null;
    return `Payment detected: ${d.received} LTC${d.receivedUsd != null ? ' (' + usd(d.receivedUsd) + ')' : ''} received so far.`
      + (left ? ` Send the remaining ${rem ? '≈ ' + rem.toFixed(6) + ' LTC ' : ''}(${usd(left)}) to the same address — your order finishes by itself.` : ' Waiting for network confirmation…');
  }

  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }

  function startPoll() {
    stopPoll();
    let ticks = 0;
    S.poll = setInterval(async () => {
      ticks += 1;
      if (!S.order || sheet.classList.contains('hidden') || ticks > 400) { stopPoll(); return; }
      try {
        const r = await api('/orders/' + S.order.id);
        const o = r.order;
        if (o.status === 'completed') { stopPoll(); await loadMe(); renderSuccess({ order: o, balance: r.balance, premium: r.premium }); return; }
        if (o.status === 'cancelled') { stopPoll(); show(head(S.pack), el('div', { class: 'msg', text: 'This order expired before the payment arrived. If you already paid, the money is in your wallet.' }), el('button', { type: 'button', class: 'cta ghost', onclick: closeSheet, text: 'Close' })); await loadMe(); return; }
        const d = r.deposit;
        if (d && d.status === 'completed' && o.status === 'awaiting_payment') { stopPoll(); await loadMe(); renderShort(o, d); return; }
        if (d && d.received > 0) renderLtc(S.ltcView, 2, partialNote(d));
      } catch { /* the next tick retries */ }
    }, 5000);
  }

  function renderShort(o, d) {
    const have = S.me ? S.me.balance : 0;
    const creditsOnly = !o.premium;                       // credit packs are paid in Litecoin only
    const missing = d && d.missingUsd != null ? d.missingUsd : Math.max(0, o.price - have);
    const ltcBtn = el('button', { type: 'button', class: 'cta', id: 'topup', text: `Pay the missing ${usd(missing)} in Litecoin`, onclick: async () => {
      const b = $('#topup'); b.disabled = true; b.textContent = 'Preparing…';
      try {
        const r = await api('/orders/' + o.id + '/topup', { method: 'POST' });
        if (r.order && r.order.status === 'completed') { await loadMe(); renderSuccess(r); return; }
        S.order = r.order; renderLtc(r); startPoll();
      } catch (err) { b.disabled = false; b.textContent = `Pay the missing ${usd(missing)} in Litecoin`; toast(err.message, true); }
    } });
    const finish = el('button', { type: 'button', class: 'cta', id: 'finish', text: 'Finish my order', onclick: async () => {
      const b = $('#finish'); b.disabled = true; b.textContent = 'Finishing…';
      try { const r = await api('/orders/' + o.id + (creditsOnly ? '/topup' : '/complete'), { method: 'POST' }); await loadMe(); renderSuccess(r); }
      catch (err) { b.disabled = false; b.textContent = 'Finish my order'; toast(err.message, true); }
    } });
    show(S.fromOrders ? backToOrders() : null, head(S.pack),
      el('div', { class: 'msg info', text: missing > 0
        ? `Your payment arrived but is ${usd(missing)} short for this pack. Pay just the difference in Litecoin and your order finishes by itself.`
        : 'Your payment is complete — finish your order.' }),
      missing > 0 ? ltcBtn : finish,
      !creditsOnly && missing > 0 && have + 1e-9 >= o.price ? finish : null,
      !creditsOnly ? el('a', { class: 'cta ghost', href: '/', style: 'display:block;text-align:center;text-decoration:none', text: 'Go top up my wallet' }) : null);
  }

  /* -------------------------------- success -------------------------------- */
  function renderSuccess(r) {
    stopPoll();
    const p = S.pack;
    const o = r.order;
    const title = p.kind === 'credits' ? 'Credits added!' : p.kind === 'premium' ? 'Premium unlocked!' : 'Welcome aboard!';
    const rows = [['Pack', p.name], ['Paid', usd(o.price)]];
    if (o.credits > 0) rows.push(['Credits added', '+' + usd(o.credits)]);
    if (o.premium) rows.push(['Premium', r.premium && r.premium.lifetime ? 'Lifetime' : r.premium && r.premium.until ? 'Until ' + dateOf(r.premium.until) : (o.premiumUntil ? 'Until ' + dateOf(o.premiumUntil) : 'Lifetime')]);
    if (r.balance !== undefined) rows.push(['Wallet balance', usd(r.balance)]);
    const ring = el('span');
    ring.innerHTML = '<svg class="ok-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="41"/><path d="M30 52l14 14 27-30"/></svg>';
    show(el('div', { class: 'ok-wrap' }, ring.firstChild,
      el('h2', { text: title }), el('p', { text: 'Everything is already on your account.' }),
      el('div', { class: 'recap' }, rows.map(([k, v]) => el('div', {}, el('span', { text: k }), el('b', { text: v })))),
      el('a', { class: 'cta', href: '/', style: 'display:block;text-decoration:none', text: o.premium ? 'Open my premium panel' : 'Open my panel' }),
      el('button', { type: 'button', class: 'cta ghost', onclick: closeSheet, text: 'Keep shopping' })));
    confetti(p.accent);
    renderPacks();   // button labels depend on premium
  }

  /* -------------------------------- confetti -------------------------------- */
  function confetti(accent) {
    if (reduced()) return;
    const cv = $('#fx');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const colors = [accent || '#ff2d3f', '#ffd166', '#ffffff', '#a855f7', '#22d3ee', '#34d399'];
    const ps = Array.from({ length: 150 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.52,
      vx: (Math.random() - 0.5) * 17, vy: -(8 + Math.random() * 13), g: 0.32 + Math.random() * 0.2,
      w: 6 + Math.random() * 7, h: 3 + Math.random() * 5, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0], life: 1,
    }));
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(2, (now - last) / 16.7); last = now;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      for (const p of ps) {
        p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.992; p.r += p.vr * dt; p.life -= 0.0042 * dt;
        if (p.life <= 0 || p.y > innerHeight + 30) continue;
        alive += 1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.6));
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      if (alive) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    requestAnimationFrame(frame);
  }

  /* --------------------------------- start --------------------------------- */
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.classList.contains('hidden')) closeSheet();
    if (e.key === 'Tab' && !sheet.classList.contains('hidden')) {   // keep the focus inside the dialog
      const f = [...sheet.querySelectorAll('button:not([disabled]), a[href]')].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', () => renderSeg());

  async function init() {
    $('#packs').replaceChildren(el('div', { class: 'skel' }), el('div', { class: 'skel' }), el('div', { class: 'skel' }));
    renderAccount();
    const [packs] = await Promise.all([
      api('/packs').catch(() => ({ packs: [], ready: false })),
      loadMe(),
    ]);
    S.packs = packs.packs || [];
    S.ready = packs.ready !== false;
    renderSeg();
    renderPacks();
    const want = new URLSearchParams(location.search).get('pack');   // /shop?pack=pro opens that pack
    const hit = want && S.packs.find((p) => p.slug === want);
    if (hit) openSheet(hit, null);
  }
  init();
})();
