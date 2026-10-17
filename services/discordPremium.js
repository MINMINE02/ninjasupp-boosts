'use strict';

/* =========================================================================
 * Discord bot for premium accounts — account linking.
 *
 *   panel  -> "Generate a link code"      (code valid 10 minutes, stored hashed)
 *   Discord-> /link code:NB-XXXX-XXXX     (proves the person controls that Discord account)
 *
 * Once linked, the bot treats the Discord user as that premium account and every
 * command only touches THAT account's stock, keys and jobs. One Discord account
 * can be linked to one premium account, and the other way around.
 *
 * Needs db/migration_discord_premium.sql. When it was not run, everything here
 * degrades to "not available" instead of throwing.
 * ========================================================================= */

const crypto = require('crypto');
const supabase = require('../config/supabase');

const CODE_TTL_MS = 10 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out and type

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** "nb-abcd efgh" / "NBABCDEFGH" -> "NB-ABCD-EFGH" (or '' when it cannot be a code). */
function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('NB') ? raw.slice(2) : raw;
  if (body.length !== 8 || [...body].some((c) => !ALPHABET.includes(c))) return '';
  return `NB-${body.slice(0, 4)}-${body.slice(4)}`;
}

function newCode() {
  let body = '';
  for (let i = 0; i < 8; i += 1) body += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `NB-${body.slice(0, 4)}-${body.slice(4)}`;
}

const userError = (message, status = 400) => Object.assign(new Error(message), { status });
const tail = (id) => (id ? `…${String(id).slice(-4)}` : null);

/** { supported, linked, tail } for the panel. */
async function status(userId) {
  const { data, error } = await supabase.from('users').select('discord_id').eq('id', userId).maybeSingle();
  if (error) return { supported: false, linked: false, tail: null };
  return { supported: true, linked: Boolean(data && data.discord_id), tail: tail(data && data.discord_id) };
}

/** Creates a one-time code for this account. The code itself is never stored, only its hash. */
async function createLinkCode(userId) {
  const code = newCode();
  const { error } = await supabase.from('users')
    .update({ discord_link_hash: hash(code), discord_link_expires: new Date(Date.now() + CODE_TTL_MS).toISOString() })
    .eq('id', userId);
  if (error) throw userError('This option is temporarily unavailable. Please contact the administrator.', 503);
  return { code, expiresInMinutes: CODE_TTL_MS / 60000 };
}

async function unlink(userId) {
  const { error } = await supabase.from('users')
    .update({ discord_id: null, discord_link_hash: null, discord_link_expires: null }).eq('id', userId);
  if (error) throw userError('This option is temporarily unavailable. Please contact the administrator.', 503);
}

/** /link in Discord. Resolves to the linked account's username. */
async function redeemLinkCode(rawCode, discordId) {
  const code = normalizeCode(rawCode);
  if (!code) throw userError('That is not a link code. Generate one in your panel (API tab → Shared bot).');
  if (!/^\d{5,25}$/.test(String(discordId || ''))) throw userError('Could not read your Discord account.');

  const { data: user, error } = await supabase.from('users')
    .select('id, username, reseller, discord_link_expires').eq('discord_link_hash', hash(code)).maybeSingle();
  if (error) throw userError('This option is temporarily unavailable.', 503);
  if (!user || !user.discord_link_expires || new Date(user.discord_link_expires).getTime() < Date.now()) {
    throw userError('This code is invalid or has expired. Generate a new one in your panel.');
  }
  if (!user.reseller) throw userError('Premium access is not active on that account.', 403);

  const { error: upErr } = await supabase.from('users')
    .update({ discord_id: String(discordId), discord_link_hash: null, discord_link_expires: null }).eq('id', user.id);
  if (upErr) {
    if (/duplicate|unique/i.test(upErr.message || '')) throw userError('This Discord account is already linked to another premium account. Use /unlink there first.', 409);
    throw upErr;
  }
  return { username: user.username };
}

/** The premium account linked to this Discord user, or null (not linked / premium ended). */
async function resolve(discordId) {
  if (!/^\d{5,25}$/.test(String(discordId || ''))) return null;
  const { data: u, error } = await supabase.from('users').select('id').eq('discord_id', String(discordId)).maybeSingle();
  if (error || !u) return null;
  try { await require('./shop').expirePremiums(u.id); } catch { /* the shop may not be set up: ignore */ }
  const { data: user } = await supabase.from('users')
    .select('id, username, reseller, balance, boost_price').eq('id', u.id).maybeSingle();
  return user && user.reseller ? user : null;
}

module.exports = { normalizeCode, newCode, hash, status, createLinkCode, unlink, redeemLinkCode, resolve, CODE_TTL_MS };
