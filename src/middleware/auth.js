'use strict';

const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

// No fallback secret here on purpose: a guessable default (or one that ends
// up committed anywhere) lets anyone forge a valid session token for any
// user, including admin. Refuse to start rather than run with a known key.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Refusing to start — set a long, random JWT_SECRET ' +
    'in the environment before running the server.'
  );
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * requireAuth — verifies the JWT, loads the current user from Supabase and
 * attaches it to req.user. Rejects with 401 when missing/invalid.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, role, balance, created_at')
    .eq('id', payload.sub)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'User no longer exists' });
  }

  req.user = user;
  next();
}

/**
 * requireAdmin — must run after requireAuth. Rejects non-admins with 403.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  next();
}

module.exports = {
  signToken,
  requireAuth,
  requireAdmin,
  JWT_SECRET,
};
