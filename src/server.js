'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Don't announce the framework in every response header — no reason to make
// fingerprinting/enumeration any easier than it already is.
app.disable('x-powered-by');

// Behind Vercel's (or any) reverse proxy, req.ip would otherwise be the
// proxy's own address for every request — collapsing every visitor into one
// shared rate-limit bucket. Trust the immediate proxy hop's X-Forwarded-For.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// SECURITY HEADERS (applied to every response — live and maintenance alike)
// ---------------------------------------------------------------------------
// Defense-in-depth against XSS: the Content-Security-Policy below allows
// scripts ONLY from this origin (script-src 'self', no 'unsafe-inline'), so
// even if some attacker-controlled value ever reaches the DOM unescaped, an
// injected inline handler or <script> (e.g. an `<img onerror=...>` that reads
// the admin's session token and POSTs it to a webhook) simply won't execute,
// and connect-src 'self' blocks any exfiltration to another origin. The app
// loads its JS from a single external bundle (/app.js) with no inline scripts
// or on*= handlers, so this doesn't break anything. 'unsafe-inline' is kept
// for styles only, which can't run JavaScript.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "media-src 'self' https:",
      "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---------------------------------------------------------------------------
// MAINTENANCE MODE
// Back online by default after the security incident lockdown/rotation.
// Set MAINTENANCE_MODE=true in the environment to lock the whole site down
// again (503 + "Under Development") without a code change.
// ---------------------------------------------------------------------------
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';

// Wires up the real app (routes, middleware, static files). Split out so it
// can be wrapped in a try/catch below: middleware/auth.js and routes/admin.js
// intentionally THROW at require-time if a required secret env var
// (JWT_SECRET, ADMIN_PANEL_PASSWORD) isn't set, and a raw throw here
// would otherwise crash the entire serverless function (500
// FUNCTION_INVOCATION_FAILED, the whole site down with no useful page) —
// falling back to the maintenance page instead is a much safer failure mode
// than a hard crash.
function setupLiveApp() {
  const { ensureAdminOnce } = require('./services/bootstrap');
  const authRoutes = require('./routes/auth');
  const boostRoutes = require('./routes/boost');
  const adminRoutes = require('./routes/admin');
  const walletRoutes = require('./routes/wallet');
  const settingsRoutes = require('./routes/settings');
  const configRoutes = require('./routes/config');
  const sellauthRoutes = require('./routes/sellauth');
  const cronRoutes = require('./routes/cron');
  const statusRoutes = require('./routes/status');
  const alerts = require('./services/alerts');
  const jobDriver = require('./services/jobDriver');
  const resellerRoutes = require('./routes/reseller');
  const v1Routes = require('./routes/v1');
  const { rateLimit } = require('./utils/rateLimit');
  const branding = require('./services/branding');
  const refPage = require('./services/refPage');
  const siteEmbed = require('./services/siteEmbed');
  const embed = require('./services/embed');

  // The frontend is served from this SAME origin, so it never needs CORS to
  // call its own API — cross-origin access is for other sites/scripts, not
  // for us. Default to allowing none; set ALLOWED_ORIGINS (comma-separated)
  // only if something legitimate actually needs cross-origin access.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : { origin: false }));
  // Keep the raw bytes of SellAuth webhooks: their HMAC signature is computed
  // over the exact body, which express.json() would otherwise re-serialise.
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith('/api/sellauth')) req.rawBody = buf;
    },
  }));

  // SellAuth dynamic delivery — mounted BEFORE the global limiter with its own
  // (higher) ceiling, since a big order sends one request per item.
  app.use('/api/sellauth', rateLimit({ windowMs: 60_000, max: 300 }), sellauthRoutes);
  app.use('/api/cron', rateLimit({ windowMs: 60_000, max: 60 }), cronRoutes);
  app.use('/api/status', rateLimit({ windowMs: 60_000, max: 120 }), statusRoutes);
  // Long-running host: keep direct SellAuth boosts moving. (Serverless: use /api/cron/sync.)
  if (!process.env.VERCEL) jobDriver.start();

  // Generous but real ceiling on the whole API, so a script that scrapes or
  // hammers endpoints it found in the page source can't do it for free. Well
  // above what a real client's 3s status polling ever needs.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 240 }));

  // --- API routes -----------------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/api/boost', boostRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/reseller', resellerRoutes);
  app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 120 }), v1Routes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/config', configRoutes);

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'ninja-boost', time: new Date().toISOString() });
  });

  // --- Static frontend ------------------------------------------------------
  // Remember the site's public address: Discord alerts link back to the admin panel with it.
  app.use((req, res, next) => { alerts.seenOrigin(req); next(); });

  // The main site's link card (set by the admin). Written into the HTML because
  // link crawlers don't run JavaScript. Must come BEFORE express.static.
  let mainHtml = null;
  app.get(['/', '/index.html'], async (req, res, next) => {
    try {
      const c = await siteEmbed.effective();
      const origin = embed.originOf(req);
      mainHtml = mainHtml || fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      const block = embed.tags({
        origin, path: '/', siteName: c.siteName, title: c.title, description: c.description, color: c.color,
        image: c.image ? embed.imageUrl(origin, '/embed/site', c.image) : `${origin}/logo.png`,
        large: Boolean(c.image),
      });
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(embed.inject(mainHtml, block));
    } catch {
      next();
    }
  });

  // Live progress page of a direct SellAuth order (/status/<job id>): public, read-only,
  // shown in the look of the reseller who sold it (colour / icon / name), or Ninja's.
  let statusHtml = null;
  app.get(/^\/status(\/.*)?$/, async (req, res) => {
    const m = req.path.match(/^\/status\/([0-9a-f-]{36})\/?$/i);
    statusHtml = statusHtml || fs.readFileSync(path.join(__dirname, 'public', 'status.html'), 'utf8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    let job = null;
    try { job = m ? await statusRoutes.directJob(m[1]) : null; } catch { job = null; }
    if (!job) return res.status(404).type('html').send(statusHtml);
    let html = statusHtml.replace('<div id="status-view" class="auth-view hidden">', '<div id="status-view" class="auth-view">');
    try {
      if (job.owner_id) {
        const { data: o } = await require('./config/supabase').from('users').select('redeem_slug').eq('id', job.owner_id).maybeSingle();
        const b = o && o.redeem_slug ? await branding.get(o.redeem_slug) : null;
        if (b) html = refPage.render(html, { ...b, title: '' }, null);
      }
    } catch { /* default look */ }
    res.type('html').send(html);
  });

  // Embed images (crawlers can't read data: URLs, so they are served from here).
  app.get('/embed/site', async (req, res) => {
    try { embed.sendImage(res, (await siteEmbed.get()).image); } catch { res.status(404).end(); }
  });
  app.get('/embed/r/:slug', async (req, res) => {
    try {
      const b = await branding.get(req.params.slug);
      embed.sendImage(res, b && (b.embed.image || b.icon));
    } catch { res.status(404).end(); }
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // Admin panel (separate page from the customer panel).
  app.get('/admin', (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });

  // A reseller's redeem page (/r/<name>) is a separate, standalone page: no
  // login, no account, nothing but "redeem a key of this reseller". It never
  // serves the main panel, and an unknown name is a plain 404.
  let redeemHtml = null;
  app.get(/^\/r(\/.*)?$/, async (req, res) => {
    const m = req.path.match(/^\/r\/([A-Za-z0-9-]{3,32})\/?$/);
    let b = null;
    try { b = m ? await branding.get(m[1]) : null; } catch { b = null; }
    redeemHtml = redeemHtml || fs.readFileSync(path.join(__dirname, 'public', 'redeem.html'), 'utf8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.status(b ? 200 : 404).type('html').send(b ? refPage.render(redeemHtml, b, { origin: embed.originOf(req), slug: m[1].toLowerCase() }) : redeemHtml);
  });

  // SPA fallback for any non-API route.
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // --- Error handler --------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Full detail goes to the server logs only.
    console.error('[error]', err);
    let status = err.status && Number.isInteger(err.status) ? err.status : 500;
    const isAdmin = Boolean(req.user && req.user.role === 'admin');
    let message;
    if (err.upstream) {
      // Anything coming from a third-party provider: never forward it, and never
      // forward its status (a 401/403 from upstream must not look like a session error).
      status = 502;
      message = 'Service temporarily unavailable. Please try again in a few minutes.';
    } else if (typeof err.type === 'string' && err.type.startsWith('entity.')) {
      status = 400;
      message = 'Invalid request';
    } else if (status >= 500 && !isAdmin) {
      message = 'Something went wrong on our side. Please try again in a few minutes.';
    } else {
      message = err.message || 'Request failed';
    }
    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  // Seed the admin as soon as the module loads (best-effort warm-up). On
  // serverless the auth routes also seed lazily via ensureAdminOnce().
  ensureAdminOnce().catch((err) =>
    console.warn('[bootstrap] Could not ensure admin account:', err.message)
  );
}

let startupError = null;
if (!MAINTENANCE_MODE) {
  try {
    setupLiveApp();
  } catch (err) {
    startupError = err;
    console.error(
      '[server] Could not start in live mode (likely a missing required env ' +
      'var) — falling back to maintenance mode instead of crashing:',
      err.message
    );
  }
}

if (MAINTENANCE_MODE || startupError) {
  app.use((req, res) => {
    res.status(503).sendFile(path.join(__dirname, 'public', 'maintenance.html'));
  });
}

// Only bind a port when run as a normal long-lived process. On Vercel the
// exported app is invoked per-request, so there is nothing to listen on.
if (!process.env.VERCEL) {
  app.listen(PORT, async () => {
    const down = MAINTENANCE_MODE || startupError;
    console.log(`Ninja Boost server listening on http://localhost:${PORT}${down ? ' [MAINTENANCE MODE]' : ''}`);
    if (!down) {
      await require('./services/bootstrap').ensureAdmin().catch(() => {});
    }
  });
}

module.exports = app;
