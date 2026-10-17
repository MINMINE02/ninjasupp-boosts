'use strict';

const crypto = require('crypto');

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

// The structural shape of a real Discord token: three base64url segments
// separated by dots (userId.timestamp.hmac). Nothing else pasted alongside
// it — email, password, 2FA/TOTP code — looks like this, so it's what lets
// us find the token regardless of where it sits in the line.
const DISCORD_TOKEN_RE = /^[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/;

/**
 * Extracts the Discord token from a pasted credential line. Accepts several
 * formats — `token`, `email:token`, `email:pass:token`,
 * `email:password:token`, and `email:pass:token:2fa` — and returns just the
 * token.
 *
 * When one of the colon-separated segments has the shape of a real Discord
 * token, that segment is used, wherever it sits. This is what makes
 * `email:pass:token:2fa` work: the token is the third segment, not the
 * last one (the trailing 2FA/TOTP code would otherwise be mistaken for it).
 * If no segment matches that shape (a bare token, or a non-standard one),
 * we fall back to the previous behaviour of taking the last segment.
 */
function extractToken(line) {
  const trimmed = String(line == null ? '' : line).trim();
  if (!trimmed) return '';
  const parts = trimmed.split(':').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return parts[tokenIndex(parts)];
}

// A trailing 2FA field: a 6–8 digit code, or a base32 secret (letters A-Z + 2-7, spaces allowed).
const LOOKS_2FA = /^(?:\d{6,8}|[A-Z2-7 ]{16,64})$/i;
const LOOSE_TOKEN_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{15,}$/;

/**
 * Index of the token inside the colon-separated parts of a credential line.
 *  1. a part shaped like a real Discord token (strict, then looser);
 *  2. otherwise, for `email:pass:token:2fa` lines whose token has an unusual shape: the part
 *     before a trailing 2FA field (the 2FA used to be taken for the token);
 *  3. otherwise the last part.
 */
function tokenIndex(parts) {
  let i = parts.findIndex((p) => DISCORD_TOKEN_RE.test(p));
  if (i >= 0) return i;
  i = parts.findIndex((p) => LOOSE_TOKEN_RE.test(p));
  if (i >= 0) return i;
  const last = parts.length - 1;
  if (parts.length >= 4 && LOOKS_2FA.test(parts[last]) && !/@/.test(parts[last - 1])) return last - 1;
  return last;
}

/**
 * One stock row ({ token, full_line }) written in the format the admin picked:
 *   'full'              -> the line as it was added (email:pass:token:2fa, or just the token)
 *   'email_pass_token'  -> email:pass:token (the 2fa part dropped)
 *   'token'             -> the bare token
 */
function formatCredential(row, format = 'full') {
  const token = String((row && row.token) || '');
  const line = String((row && row.full_line) || '').trim();
  if (format === 'token' || !line) return token;
  if (format === 'email_pass_token') {
    const parts = line.split(':').map((p) => p.trim());
    const at = parts.indexOf(token);
    return at >= 0 ? parts.slice(0, at + 1).join(':') : line;
  }
  return line;
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
    code += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
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
  tokenIndex,
  formatCredential,
  generateKeyCode,
  normalizeKeyCode,
  validateUsername,
  KEY_LENGTH,
};
