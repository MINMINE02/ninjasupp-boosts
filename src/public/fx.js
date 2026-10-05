/* Ninja Boost — tiny visual effects (cursor spotlight + button ripple).
   Self-contained, no dependencies, no inline code (CSP-safe). */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  // Cursor-follow red spotlight (fine pointers only)
  if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
    var spot = document.createElement('div');
    spot.className = 'fx-spot';
    document.body.appendChild(spot);
    var x = 0, y = 0, tx = 0, ty = 0, raf = 0;
    var loop = function () {
      x += (tx - x) * 0.14; y += (ty - y) * 0.14;
      spot.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      raf = (Math.abs(tx - x) > 0.5 || Math.abs(ty - y) > 0.5) ? requestAnimationFrame(loop) : 0;
    };
    window.addEventListener('pointermove', function (e) {
      tx = e.clientX; ty = e.clientY;
      spot.classList.add('on');
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    document.addEventListener('pointerleave', function () { spot.classList.remove('on'); });
  }

  // Click ripple on buttons
  document.addEventListener('pointerdown', function (e) {
    var t = e.target.closest && e.target.closest('.btn, .start-btn, .buy-pill, .acc-btn, .auth-tab, .ts-tab, .site-watermark a');
    if (!t || t.disabled) return;
    var r = t.getBoundingClientRect();
    var size = Math.max(r.width, r.height) * 2;
    var d = document.createElement('span');
    d.className = 'fx-ripple';
    d.style.width = d.style.height = size + 'px';
    d.style.left = (e.clientX - r.left - size / 2) + 'px';
    d.style.top = (e.clientY - r.top - size / 2) + 'px';
    if (getComputedStyle(t).position === 'static') t.style.position = 'relative';
    t.style.overflow = t.style.overflow || 'hidden';
    t.appendChild(d);
    setTimeout(function () { d.remove(); }, 650);
  }, { passive: true });
})();
