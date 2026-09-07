'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncHandler, validateUsername } = require('../utils/helpers');
const { ensureAdminOnce } = require('../services/bootstrap');
const { rateLimit } = require('../utils/rateLimit');

const router = express.Router();

// Login/register are the front door to every account — cap attempts per IP
// so credentials (or the admin account) can't be brute-forced.
const authLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// Seed the bootstrap admin lazily on the first auth request. This is what
// makes the admin login work on serverless hosts (Vercel), where the server
// never calls app.listen() and cannot seed on start-up. Errors are ignored
// so a normal login/register still proceeds.
router.use(async (req, res, next) => {
  try { await ensureAdminOnce(); } catch { /* seeding is best-effort */ }
  next();
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    balance: Number(user.balance ?? 0),
    createdAt: user.created_at,
  };
}

// POST /api/auth/register — create a BYOT account.
router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { username: rawUsername, password } = req.body || {};
    if (!rawUsername || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const check = validateUsername(rawUsername);
    if (!check.ok) {
      return res.status(400).json({ error: check.error });
    }
    const username = check.username;
    if (String(password).length < 6) {
      return res
        .status(400)
        .json({ error: 'Password must be at least 6 characters' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const password_hash = await bcrypt.hash(String(password), 10);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ username, password_hash, role: 'user' })
      .select('id, username, role, balance, created_at')
      .single();

    if (error) throw error;

    const token = signToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  })
);

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, username, role, balance, created_at, password_hash')
      .eq('username', username)
      .maybeSingle();

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  })
);

module.exports = router;
module.exports.publicUser = publicUser;
