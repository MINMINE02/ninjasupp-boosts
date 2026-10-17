/* Ninja Boost — accent colour theming.
   One chosen colour -> the whole palette (shades, glows, text colour).
   Works in the browser (window.NBTheme) AND on the server (require), so the
   reseller's redeem page can be themed before the first paint. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NBTheme = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEX = /^#?([0-9a-f]{6})$/i;
  var WHITE = [255, 255, 255];
  var BLACK = [0, 0, 0];

  function parse(v) {
    var m = HEX.exec(String(v == null ? '' : v).trim());
    return m ? '#' + m[1].toLowerCase() : null;
  }
  function rgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); }
  function hex(c) {
    return '#' + c.map(function (v) {
      return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
    }).join('');
  }
  function mix(a, b, t) { return a.map(function (v, i) { return v * (1 - t) + b[i] * t; }); }
  function lum(c) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  var list = function (c) { return c.map(Math.round).join(', '); };

  // CSS custom properties for one accent colour, or null if it isn't a hex.
  function vars(color) {
    var h = parse(color);
    if (!h) return null;
    var base = rgb(h);
    // Near-black accents vanish on the black background: lift them a little.
    for (var i = 0; i < 6 && lum(base) < 0.07; i++) base = mix(base, WHITE, 0.14);
    var dark = mix(base, BLACK, 0.23);
    return {
      '--accent': hex(base),
      '--accent-bright': hex(mix(base, WHITE, 0.12)),
      '--accent-2': hex(mix(base, WHITE, 0.28)),
      '--accent-hi': hex(mix(base, WHITE, 0.22)),
      '--accent-tint': hex(mix(base, WHITE, 0.82)),
      '--accent-dark': hex(dark),
      '--accent-deep': hex(mix(base, BLACK, 0.46)),
      '--accent-rgb': list(base),
      '--accent-dark-rgb': list(dark),
      '--border-strong': hex(mix([38, 34, 36], base, 0.14)),
      // readable label on the accent fill (light accents get dark text)
      '--on-accent': lum(base) > 0.5 ? '#0b0b0b' : '#ffffff',
    };
  }

  // "--a:#fff;--b:#000" — for a style="" attribute (server-side injection).
  function style(color) {
    var v = vars(color);
    if (!v) return '';
    return Object.keys(v).map(function (k) { return k + ':' + v[k]; }).join(';');
  }

  function apply(color, el) {
    var v = vars(color);
    el = el || document.documentElement;
    if (!v) { reset(el); return false; }
    Object.keys(v).forEach(function (k) { el.style.setProperty(k, v[k]); });
    return true;
  }
  function reset(el) {
    el = el || document.documentElement;
    ['--accent', '--accent-bright', '--accent-2', '--accent-hi', '--accent-tint', '--accent-dark',
     '--accent-deep', '--accent-rgb', '--accent-dark-rgb', '--border-strong', '--on-accent']
      .forEach(function (k) { el.style.removeProperty(k); });
  }

  return { parse: parse, vars: vars, style: style, apply: apply, reset: reset };
});
