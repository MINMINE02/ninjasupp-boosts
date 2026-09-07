'use strict';

/**
 * Wraps an async route handler so thrown errors are forwarded to Express'
 * error middleware instead of crashing the process.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Extracts a bare invite code from anything the user might paste:
 *   - "discord.gg/example"          -> "example"
 *   - "https://discord.gg/example"  -> "example"
 *   - "https://discord.com/invite/x"-> "x"
 *   - "example"                     -> "example"
 */
function parseInviteCode(input) {
  if (!input || typeof input !== 'string') return '';
  let value = input.trim();

  const match = value.match(
    /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/([A-Za-z0-9-]+)/i
  );
  if (match) return match[1];

  // Strip any trailing query string / slashes from a plain code.
  value = value.replace(/^\/+|\/+$/g, '').split(/[?#\s]/)[0];
  return value;
}

/**
 * Extracts the Discord token from a pasted credential line. Accepts several
 * formats — `token`, `email:token`, `email:pass:token`,
 * `email:password:token` — and returns just the token, which is the final
 * colon-separated segment (Discord tokens themselves never contain a colon).
 */
function extractToken(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed) return '';
  const parts = trimmed.split(':');
  return parts[parts.length - 1].trim();
}

/**
 * Splits a textarea blob of tokens (one per line) into a clean array,
 * normalising each line to its token, trimming whitespace and dropping blank
 * lines / duplicates.
 */
function parseTokenList(input) {
  if (Array.isArray(input)) {
    input = input.join('\n');
  }
  if (!input || typeof input !== 'string') return [];

  const seen = new Set();
  const tokens = [];
  for (const line of input.split(/\r?\n/)) {
    const token = extractToken(line);
    if (token && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Like parseTokenList, but keeps the original line alongside the extracted
 * token so callers that need to persist/copy the FULL credential (e.g.
 * `email:pass:token`, not just the bare token) can. Deduped by token, same
 * as parseTokenList.
 */
function parseCredentialList(input) {
  if (Array.isArray(input)) {
    input = input.join('\n');
  }
  if (!input || typeof input !== 'string') return [];

  const seen = new Set();
  const rows = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    const token = extractToken(line);
    if (token && !seen.has(token)) {
      seen.add(token);
      rows.push({ token, line });
    }
  }
  return rows;
}

// 16-character keys made of uppercase letters and digits.
const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const KEY_LENGTH = 16;

/**
 * Generates a redeem key: 16 uppercase letters/digits, e.g. "A1B2C3D4E5F6G7H8".
 */
function generateKeyCode() {
  let code = '';
  for (let i = 0; i < KEY_LENGTH; i += 1) {
    code += KEY_ALPHABET[Math.floor(Math.random() * KEY_ALPHABET.length)];
  }
  return code;
}

/**
 * Normalises user-entered key input: uppercases and strips anything that is
 * not a letter or digit (spaces, dashes). Returns '' if the result is not a
 * valid 16-character key.
 */
function normalizeKeyCode(input) {
  if (!input || typeof input !== 'string') return '';
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === KEY_LENGTH ? cleaned : '';
}

// Usernames: 3–32 chars, must start with a letter or digit, and may then
// contain only letters, digits, and the separators . _ -. This strict
// allowlist rejects quotes, angle brackets, spaces, semicolons and comment
// markers — everything an injection/XSS/abuse string relies on (e.g.
// `<img src=x onerror=...>` or `' OR 1=1--`). The DB layer already
// parameterises every value, so this is defense-in-depth plus basic input
// hygiene so junk/hostile accounts can't be registered in the first place.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

/**
 * Validates a desired username. Returns { ok: true, username } with the
 * trimmed value, or { ok: false, error } with a human-readable reason.
 */
function validateUsername(input) {
  const username = String(input == null ? '' : input).trim();
  if (!username) {
    return { ok: false, error: 'Username is required' };
  }
  if (username.length < 3 || username.length > 32) {
    return { ok: false, error: 'Username must be 3–32 characters' };
  }
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error:
        'Username may only contain letters, numbers, and . _ - ' +
        '(and must start with a letter or number)',
    };
  }
  return { ok: true, username };
}

module.exports = {
  asyncHandler,
  parseInviteCode,
  parseTokenList,
  parseCredentialList,
  extractToken,
  generateKeyCode,
  normalizeKeyCode,
  validateUsername,
  KEY_LENGTH,
};
