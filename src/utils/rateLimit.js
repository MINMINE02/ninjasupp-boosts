'use strict';

/**
 * Minimal in-memory sliding-window rate limiter for sensitive auth
 * endpoints (login, register, admin unlock). No new dependency needed for
 * something this small. Keyed by IP + route so one abusive client can't
 * starve out others.
 */
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // key -> [timestamps]

  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);

    if (recent.length > max) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  };
}

module.exports = { rateLimit };
