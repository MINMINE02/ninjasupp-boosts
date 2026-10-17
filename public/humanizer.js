'use strict';

/* Ninja Boost — "Account profile" card (Salta7 humanizer).
 *
 * Shared by the main panel's redeem tab and the standalone reseller redeem
 * page. It injects an optional card into the REDEEM KEY section (so it hides
 * together with it) and exposes:
 *   NBHumanizer.payload()      -> { avatar?, name?, bio? } or null   (sent as `humanize`)
 *   NBHumanizer.showStatus(h)  -> shows/hides the result-page row from the server's `humanize` state
 *   NBHumanizer.isPending(h)   -> true while the profile is still being applied (keep polling)
 * Plain JS, no inline handlers (the site's CSP only allows scripts from this origin). */
(function () {
  var NAME_MAX = 32;
  var BIO_MAX = 190;
  var S = { avatar: null, avatarRandom: false, nameRandom: false, bioRandom: false };

  var CSS =
    '.hz-card{grid-column:1/-1}' +
    '.hz-pill{margin-left:auto;align-self:flex-start;font-size:11px;font-weight:600;letter-spacing:.04em;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.14);color:var(--muted,#9a9aa5);white-space:nowrap}' +
    '.hz-grid{display:grid;grid-template-columns:200px minmax(0,1fr);gap:26px;align-items:start}' +
    '.hz-side{display:flex;flex-direction:column;align-items:center;gap:12px}' +
    '.hz-av-wrap{position:relative;width:132px;height:132px;border-radius:50%;cursor:pointer;display:grid;place-items:center;' +
      'background:rgba(255,255,255,.04);border:2px dashed rgba(255,255,255,.2);overflow:hidden;transition:border-color .2s,background .2s}' +
    '.hz-av-wrap:hover{border-color:rgba(var(--accent-rgb,255,45,63),.8);background:rgba(var(--accent-rgb,255,45,63),.08)}' +
    '.hz-av-wrap.has{border-style:solid}' +
    '.hz-av{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}' +
    '.hz-av-wrap.has .hz-av{display:block}' +
    '.hz-av-ph{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted,#9a9aa5);text-align:center;padding:0 12px}' +
    '.hz-av-ph svg{width:26px;height:26px}' +
    '.hz-av-wrap.has .hz-av-ph{display:none}' +
    '.hz-av-wrap.hz-off{opacity:.4}' +
    '.hz-side-actions{display:flex;flex-wrap:wrap;gap:8px 14px;justify-content:center;align-items:center}' +
    '.hz-link{cursor:pointer;font:inherit;font-size:12px;font-weight:600;color:var(--accent-2,#ff6b78);background:none;border:0;padding:0}' +
    '.hz-link:hover{text-decoration:underline}' +
    '.hz-fields{display:flex;flex-direction:column;gap:18px;min-width:0}' +
    '.hz-field-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}' +
    '.hz-field-head .field-label{margin:0}' +
    '.hz-rand{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted,#9a9aa5);cursor:pointer;user-select:none;white-space:nowrap}' +
    '.hz-rand input{accent-color:var(--accent,#ff2d3f);width:15px;height:15px;margin:0}' +
    '.hz-bio{min-height:96px;resize:vertical;font-family:inherit}' +
    '.hz-count{font-size:11px;color:var(--muted,#9a9aa5);text-align:right;margin-top:6px}' +
    '.hz-off{opacity:.4;pointer-events:none}' +
    '@media (max-width:760px){.hz-grid{grid-template-columns:minmax(0,1fr);gap:20px}.hz-side{flex-direction:row;justify-content:flex-start;gap:16px}.hz-av-wrap{width:92px;height:92px;flex:none}.hz-side-actions{justify-content:flex-start;flex-direction:column;align-items:flex-start;gap:8px}}';

  var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  var ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

  var HTML =
    '<div class="sec-head">' +
      '<span class="sec-badge">' + ICON_USER + '</span>' +
      '<div><div class="sec-title">Account profile</div>' +
      '<div class="sec-sub">Give the boosting accounts a picture, name and bio. Leave a field empty to keep it unchanged.</div></div>' +
      '<span class="hz-pill">OPTIONAL</span>' +
    '</div>' +
    '<div class="hz-grid">' +
      '<div class="hz-side" id="hz-av-row">' +
        '<div class="hz-av-wrap" id="hz-av-pick" role="button" tabindex="0" aria-label="Upload a profile picture">' +
          '<img class="hz-av" id="hz-av-prev" alt="" />' +
          '<span class="hz-av-ph">' + ICON_IMG + 'Upload image</span>' +
        '</div>' +
        '<div class="hz-side-actions">' +
          '<label class="hz-rand"><input type="checkbox" id="hz-av-rand" /> Random picture</label>' +
          '<button type="button" class="hz-link hidden" id="hz-av-clear">Remove</button>' +
        '</div>' +
        '<input type="file" id="hz-av-file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden" />' +
      '</div>' +
      '<div class="hz-fields">' +
        '<div><div class="hz-field-head"><span class="field-label">Name</span>' +
          '<label class="hz-rand"><input type="checkbox" id="hz-name-rand" /> Random</label></div>' +
          '<input type="text" id="hz-name" class="sec-input" maxlength="' + NAME_MAX + '" placeholder="Display name" autocomplete="off" /></div>' +
        '<div><div class="hz-field-head"><span class="field-label">Bio</span>' +
          '<label class="hz-rand"><input type="checkbox" id="hz-bio-rand" /> Random</label></div>' +
          '<textarea id="hz-bio" class="sec-input hz-bio" maxlength="' + BIO_MAX + '" placeholder="About me"></textarea>' +
          '<div class="hz-count" id="hz-bio-count">0/' + BIO_MAX + '</div></div>' +
      '</div>' +
    '</div>';

  function $(id) { return document.getElementById(id); }

  function refresh() {
    var prev = $('hz-av-prev');
    var wrap = $('hz-av-pick');
    if (S.avatar) { prev.src = S.avatar; } else { prev.removeAttribute('src'); }
    wrap.classList.toggle('has', !!S.avatar);
    wrap.classList.toggle('hz-off', S.avatarRandom);
    $('hz-av-clear').classList.toggle('hidden', !S.avatar);
    $('hz-name').classList.toggle('hz-off', S.nameRandom);
    $('hz-bio').classList.toggle('hz-off', S.bioRandom);
    $('hz-bio-count').textContent = $('hz-bio').value.length + '/' + BIO_MAX;
  }

  // Centre-crop to a square and shrink to 256x256 JPEG (what Discord uses anyway),
  // so the request stays small.
  function toAvatar(file, done) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var side = Math.min(img.width, img.height);
        var c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 256);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
        done(c.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = function () { done(null); };
      img.src = String(fr.result);
    };
    fr.onerror = function () { done(null); };
    fr.readAsDataURL(file);
  }

  function build() {
    var host = $('pm-stock');
    if (!host || $('hz-box')) return;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    var box = document.createElement('div');
    box.className = 'sec-card hz-card';
    box.id = 'hz-box';
    box.innerHTML = HTML; // static markup only, no user data
    host.parentNode.insertBefore(box, host.nextSibling);
    // it belongs to the redeem section: hidden whenever that section is (BYOT mode on the main panel)
    var follow = function () { box.classList.toggle('hidden', host.classList.contains('hidden')); };
    if (window.MutationObserver) new MutationObserver(follow).observe(host, { attributes: true, attributeFilter: ['class'] });
    follow();

    var pick = function () { if (!S.avatarRandom) $('hz-av-file').click(); };
    $('hz-av-pick').addEventListener('click', pick);
    $('hz-av-pick').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    $('hz-av-file').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f || !/^image\//.test(f.type) || f.size > 8 * 1024 * 1024) return;
      toAvatar(f, function (url) { if (url) { S.avatar = url; refresh(); } });
    });
    $('hz-av-clear').addEventListener('click', function () { S.avatar = null; refresh(); });
    $('hz-av-rand').addEventListener('change', function () { S.avatarRandom = this.checked; refresh(); });
    $('hz-name-rand').addEventListener('change', function () { S.nameRandom = this.checked; refresh(); });
    $('hz-bio-rand').addEventListener('change', function () { S.bioRandom = this.checked; refresh(); });
    $('hz-bio').addEventListener('input', refresh);
    refresh();
  }

  function payload() {
    if (!$('hz-box')) return null;
    var out = {};
    if (S.avatarRandom) out.avatar = { source: 'random' };
    else if (S.avatar) out.avatar = { source: 'custom', value: S.avatar };
    var name = $('hz-name').value.trim();
    if (S.nameRandom) out.name = { source: 'random' };
    else if (name) out.name = { source: 'custom', value: name };
    var bio = $('hz-bio').value.trim();
    if (S.bioRandom) out.bio = { source: 'random' };
    else if (bio) out.bio = { source: 'custom', value: bio };
    return Object.keys(out).length ? out : null;
  }

  /* ----- result page row ----- */
  function ensureRow() {
    var row = $('hz-status');
    if (row) return row;
    var anchor = $('rr-server');
    var section = anchor && anchor.closest('.rr-section');
    if (!section) return null;
    row = document.createElement('div');
    row.className = 'rr-section hidden';
    row.id = 'hz-status';
    row.innerHTML =
      '<div class="rr-label">Account profile</div>' +
      '<div class="rr-info"><span>Status</span><strong id="hz-status-text">—</strong></div>';
    section.parentNode.insertBefore(row, section.nextSibling);
    return row;
  }

  function showStatus(h) {
    var row = ensureRow();
    if (!row) return;
    if (!h) { row.classList.add('hidden'); return; }
    var t = '—';
    if (h.status === 'pending') t = 'Queued — applied once the boost is done';
    else if (h.status === 'running') t = 'Applying… ' + (h.humanized || 0) + '/' + (h.total || '?');
    else if (h.status === 'completed') t = 'Applied to ' + (h.humanized || h.total || 0) + ' accounts';
    else if (h.status === 'partial') t = 'Applied to ' + (h.humanized || 0) + ' of ' + (h.total || 0) + ' accounts';
    else if (h.status === 'skipped') t = 'Skipped — no account joined';
    else if (h.status === 'failed') t = 'Could not be applied';
    $('hz-status-text').textContent = t;
    row.classList.remove('hidden');
  }

  function isPending(h) { return !!h && (h.status === 'pending' || h.status === 'running'); }

  window.NBHumanizer = { payload: payload, showStatus: showStatus, isPending: isPending };

  // The admin can switch the option off (Settings -> Account profile): then no card at all.
  function start() {
    fetch('/api/config/humanizer', { credentials: 'omit', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { enabled: true }; })
      .catch(function () { return { enabled: true }; })
      .then(function (d) { if (!d || d.enabled !== false) build(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
