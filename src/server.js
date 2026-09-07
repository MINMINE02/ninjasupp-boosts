'use strict';

require('dotenv').config();

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
  const { rateLimit } = require('./utils/rateLimit');

  // The frontend is served from this SAME origin, so it never needs CORS to
  // call its own API — cross-origin access is for other sites/scripts, not
  // for us. Default to allowing none; set ALLOWED_ORIGINS (comma-separated)
  // only if something legitimate actually needs cross-origin access.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : { origin: false }));
  app.use(express.json({ limit: '1mb' }));

  // Generous but real ceiling on the whole API, so a script that scrapes or
  // hammers endpoints it found in the page source can't do it for free. Well
  // above what a real client's 3s status polling ever needs.
  app.use('/api', rateLimit({ windowMs: 60_000, max: 240 }));

  // --- API routes -----------------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/api/boost', boostRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/config', configRoutes);

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'ninja-boost', time: new Date().toISOString() });
  });

  // --- Static frontend ------------------------------------------------------
  app.use(express.static(path.join(__dirname, 'public')));

  // SPA fallback for any non-API route.
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // --- Error handler --------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
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
