'use strict';

/* Ninja Boost — "Tracking link" row on the redeem result page.
 * After a redeem, the customer gets a link (/status/<job id>) that keeps showing the boost
 * progress even after the page is closed. Shared by the main panel and the reseller pages.
 *   NBTrack.show(jobId)  -> shows the link + a Copy button
 *   NBTrack.hide()       -> hides it (back to the form)
 * Plain JS, no inline handlers (the site's CSP only allows scripts from this origin). */
(function () {
  function $(id) { return document.getElementById(id); }

  function ensureRow() {
    var row = $('trk-row');
    if (row) return row;
    var anchor = $('rr-server');
    var section = anchor && anchor.closest('.rr-section');
    if (!section) return null;
    row = document.createElement('div');
    row.className = 'rr-section hidden';
    row.id = 'trk-row';
    row.innerHTML =
      '<div class="rr-label">Tracking link</div>' +
      '<div class="field-help" style="margin-bottom:8px">Keep this link: it shows how your boost is going, even if you close this page.</div>' +
      '<div style="display:flex;gap:8px">' +
      '<input id="trk-link" class="sec-input" type="text" readonly style="flex:1;min-width:0" aria-label="Tracking link" />' +
      '<button type="button" id="trk-copy" class="btn btn-secondary" style="white-space:nowrap">Copy</button>' +
      '</div>';
    section.parentNode.insertBefore(row, section.nextSibling);
    $('trk-link').addEventListener('focus', function () { this.select(); });
    $('trk-copy').addEventListener('click', function () {
      var link = $('trk-link').value;
      var btn = this;
      var done = function (ok) {
        btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C';
        if (!ok) $('trk-link').select();
        setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
    return row;
  }

  function show(jobId) {
    var row = ensureRow();
    if (!row || !/^[0-9a-f-]{36}$/i.test(String(jobId || ''))) return;
    $('trk-link').value = location.origin + '/status/' + jobId;
    row.classList.remove('hidden');
  }

  function hide() {
    var row = $('trk-row');
    if (row) row.classList.add('hidden');
  }

  window.NBTrack = { show: show, hide: hide };
})();
