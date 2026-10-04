'use strict';

/* =========================================================================
 * Link embed ("the card Discord shows when you paste the link").
 *
 * Crawlers (Discord, Telegram, WhatsApp, X…) don't run JavaScript, so the
 * <meta> tags are written into the HTML by the server. Everything inserted is
 * escaped or validated. Images are served from /embed/... (crawlers can't read
 * data: URLs), with a version in the URL so a changed image refreshes.
 * ========================================================================= */

const crypto = require('crypto');

const MAX_IMAGE_CHARS = 450000; // base64 text, ~330 KB of image
const LIMITS = { title: 70, description: 300, siteName: 40 };
const SITE_KEYS = ['embed_title', 'embed_description', 'embed_color', 'embed_image', 'embed_site'];
const DEFAULT_SITE = {
  siteName: 'Ninja Boost',
  title: 'Ninja Boost — Key Redeem Panel',
  description: 'Redeem your key and boost your server in seconds.',
  color: '#ff2d3f',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const colour = (v) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v == null ? '' : v).trim());
  return m ? `#${m[1].toLowerCase()}` : '';
};

const DATA_IMG = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const HTTPS_URL = /^https:\/\/[^\s"'<>]{4,400}$/i;

// '' (clear) | valid data URL / https URL -> the value; anything else -> null (invalid)
function imageValue(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (DATA_IMG.test(s) && s.length <= MAX_IMAGE_CHARS) return s;
  if (HTTPS_URL.test(s)) return s;
  return null;
}
function decodeImage(v) {
  const m = DATA_IMG.exec(String(v || ''));
  if (!m) return null;
  return { type: `image/${m[1]}`, buffer: Buffer.from(m[2], 'base64') };
}
const version = (v) => crypto.createHash('md5').update(String(v || '')).digest('hex').slice(0, 8);

// Send an image (stored as a data URL) as a real image response; https URLs redirect.
function sendImage(res, value) {
  if (!value) return res.status(404).end();
  if (HTTPS_URL.test(value)) return res.redirect(302, value);
  const img = decodeImage(value);
  if (!img) return res.status(404).end();
  res.set({
    'Content-Type': img.type,
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  return res.send(img.buffer);
}

// Absolute URL helpers
const isHttps = (v) => HTTPS_URL.test(String(v || ''));
function imageUrl(origin, routePath, value) {
  if (!value) return '';
  return isHttps(value) ? value : `${origin}${routePath}?v=${version(value)}`;
}

function tags({ origin, path, siteName, title, description, color, image, large }) {
  const url = `${origin}${path}`;
  const out = [
    `<meta name="description" content="${esc(description)}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${esc(siteName)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta name="twitter:card" content="${image && large ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
  ];
  if (color) out.push(`<meta name="theme-color" content="${esc(color)}" />`);
  if (image) {
    out.push(`<meta property="og:image" content="${esc(image)}" />`, `<meta name="twitter:image" content="${esc(image)}" />`);
  }
  return `  ${out.join('\n  ')}\n`;
}

// Insert the tags (replacing any <meta name="description"> already there) before </head>.
function inject(html, block) {
  const cleaned = html.replace(/\s*<meta name="description"[^>]*>/i, '');
  return cleaned.includes('</head>') ? cleaned.replace('</head>', `${block}</head>`) : cleaned;
}

const originOf = (req) => {
  const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:-]/g, '');
  return `${req.protocol}://${host}`;
};

module.exports = { MAX_IMAGE_CHARS, LIMITS, SITE_KEYS, DEFAULT_SITE, esc, text, colour, imageValue, decodeImage, sendImage, imageUrl, tags, inject, originOf, isHttps };
