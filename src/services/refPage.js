'use strict';

// Renders public/index.html for a reseller's redeem page with that reseller's
// colour, icon and names already in place — no flash of the default branding.
// Everything inserted is escaped; the colour is re-validated as #rrggbb.

const theme = require('../public/theme.js');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFE_ICON = /^(data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}|https:\/\/[^\s"'<>]+)$/;

function render(html, b) {
  if (!b) return html;
  let out = html;

  const css = theme.style(b.color);
  if (css) out = out.replace('<html lang="en">', `<html lang="en" style="${css}">`);

  const brand = b.brand ? esc(b.brand) : '';
  const heading = esc(b.title || b.brand || '');

  if (brand) {
    out = out.split('<span class="logo-word">Ninja Boost</span>').join(`<span class="logo-word">${brand}</span>`);
    out = out.split('alt="Ninja Boost"').join(`alt="${brand}"`);
  }
  if (heading) {
    out = out.replace('<title>Ninja Boost</title>', `<title>${heading}</title>`);
    out = out.replace('<span class="brand-top">Ninja Boost</span>', `<span class="brand-top">${heading}</span>`);
  }
  if (b.icon && SAFE_ICON.test(b.icon)) {
    out = out.split('src="/logo.gif"').join(`src="${b.icon}"`);
    out = out.replace('<link rel="icon" type="image/png" href="/logo.png" />', `<link rel="icon" href="${b.icon}" />`);
  }
  return out;
}

module.exports = { render };
