'use strict';
/*
 * Standalone admin-account credential change.
 *
 * Loaded as its own same-origin script (<script src="/admin-account.js">)
 * instead of being baked into the main app bundle: some builds of this
 * project ship an obfuscated/minified public/app.js with no reproducible
 * build step in the repo, so wiring this into that bundle isn't reliable.
 * This file only touches the #save-admin-btn card added to index.html and
 * talks to the admin API directly, so it works regardless of how app.js was
 * built. The strict CSP (script-src 'self') allows it — it's same-origin.
 */
(function () {
  var TOKEN_KEY = 'db_token';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else { fn(); }
  }

  ready(function () {
    var btn = document.getElementById('save-admin-btn');
    if (!btn) return; // card not present on this page
    var userEl = document.getElementById('admin-new-username');
    var passEl = document.getElementById('admin-new-password');
    var msg = document.getElementById('admin-message');

    function setMsg(text, kind) {
      if (!msg) return;
      msg.className = 'form-message' + (kind ? ' ' + kind : '');
      msg.textContent = text;
    }

    function token() {
      try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    }

    // Prefill the current username from the logged-in session.
    (function prefill() {
      var t = token();
      if (!t || !userEl || userEl.value) return;
      fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + t } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.user && d.user.username && !userEl.value) userEl.value = d.user.username;
        })
        .catch(function () {});
    })();

    btn.addEventListener('click', function () {
      setMsg('', '');
      var username = (userEl && userEl.value ? userEl.value : '').trim();
      var password = passEl && passEl.value ? passEl.value : '';
      if (!username) { setMsg('Username is required', 'error'); return; }
      if (password.length < 6) { setMsg('Password must be at least 6 characters', 'error'); return; }
      var t = token();
      if (!t) { setMsg('You are not logged in', 'error'); return; }

      btn.disabled = true;
      setMsg('Saving\u2026', '');
      fetch('/api/admin/credentials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      }).then(function (r) {
        if (!r.ok) throw new Error(r.data && r.data.error ? r.data.error : 'Request failed (' + r.status + ')');
        try { if (r.data.token) localStorage.setItem(TOKEN_KEY, r.data.token); } catch (e) {}
        if (passEl) passEl.value = '';
        setMsg((r.data && r.data.message) || 'Admin account updated. Reloading\u2026', 'success');
        setTimeout(function () { location.reload(); }, 1200);
      }).catch(function (err) {
        setMsg(err.message || 'Something went wrong', 'error');
      }).then(function () { btn.disabled = false; });
    });
  });
})();
