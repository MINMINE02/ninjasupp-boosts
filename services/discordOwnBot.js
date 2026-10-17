'use strict';

/* =========================================================================
 * A premium account's OWN Discord bot, in its OWN server.
 *
 * The account creates its own Discord application and gives the panel:
 *   - the Application ID and the Public Key (to verify Discord's requests),
 *   - the bot token ONCE, only to register the slash commands — it is never stored,
 *   - the Discord user ids allowed to use the bot.
 * Discord then calls  /api/discord/u/<endpointId>/interactions  (a random, per-account address).
 * Every command acts on that account's stock only (see handleOwnedInteraction in discordBot.js).
 *
 * Needs db/migration_discord_ownbot.sql; without it everything reports "not available".
 * ========================================================================= */

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { personalCommands } = require('./discordCommands');

const MAX_ALLOWED = 20;
const userError = (message, status = 400) => Object.assign(new Error(message), { status });
const UNAVAILABLE = 'This option is temporarily unavailable. Please contact the administrator.';

/** "123, 456 789" -> ['123','456','789'] (only real Discord ids, no duplicates, at most 20). */
function parseAllowedIds(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => /^\d{5,25}$/.test(x)))].slice(0, MAX_ALLOWED);
}

const isAppId = (v) => /^\d{5,25}$/.test(String(v || ''));
const isPublicKey = (v) => /^[0-9a-f]{64}$/i.test(String(v || ''));
const newEndpointId = () => crypto.randomBytes(16).toString('hex');

/** Registers the slash commands on the account's own application. The token is used here and dropped. */
async function registerCommands(appId, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(personalCommands),
      signal: ctrl.signal,
    });
    if (r.status === 401) throw userError('Discord refused the bot token. Copy it again from the Bot tab (Reset Token).');
    if (r.status === 403 || r.status === 404) throw userError('The Application ID does not match this bot token. Check both in the Developer Portal.');
    if (r.status === 429) throw userError('Discord is rate-limiting this bot, try again in a minute.', 429);
    if (!r.ok) throw userError(`Discord could not register the commands (${r.status}).`, 502);
  } catch (err) {
    if (err.status) throw err;
    throw userError('Could not reach Discord, try again.', 502);
  } finally {
    clearTimeout(t);
  }
}

/** What the panel shows. Never includes the public key's full value or any token. */
async function getConfig(userId) {
  const { data, error } = await supabase.from('users')
    .select('bot_app_id, bot_public_key, bot_endpoint_id, bot_allowed_ids').eq('id', userId).maybeSingle();
  if (error) return { supported: false };
  const d = data || {};
  return {
    supported: true,
    configured: Boolean(d.bot_app_id && d.bot_public_key && d.bot_endpoint_id),
    appId: d.bot_app_id || '',
    publicKeySet: Boolean(d.bot_public_key),
    endpointId: d.bot_endpoint_id || null,
    allowedIds: parseAllowedIds(d.bot_allowed_ids),
  };
}

/**
 * Saves the settings. `token` is optional once the commands are registered (only needed the first time,
 * or to register them again after an update).
 */
async function save(userId, { appId, publicKey, token, allowedIds }) {
  const cur = await getConfig(userId);
  if (!cur.supported) throw userError(UNAVAILABLE, 503);

  const app = String(appId || cur.appId || '').trim();
  const pk = String(publicKey || '').trim();
  if (!isAppId(app)) throw userError('The Application ID is a number of 17–20 digits (Developer Portal → General Information).');
  if (!pk && !cur.publicKeySet) throw userError('The Public Key is required (64 characters, General Information).');
  if (pk && !isPublicKey(pk)) throw userError('The Public Key must be 64 hexadecimal characters.');
  const ids = parseAllowedIds(allowedIds);
  if (!ids.length) throw userError('Add at least your own Discord user id: only the ids listed here can use the bot.');

  const tok = String(token || '').trim();
  if (tok) {
    if (tok.length > 200 || /\s/.test(tok)) throw userError('That does not look like a bot token.');
    await registerCommands(app, tok);
  } else if (!cur.configured || app !== cur.appId) {
    throw userError('Paste the bot token once so the commands can be registered (it is not saved).');
  }

  const patch = { bot_app_id: app, bot_allowed_ids: ids.join(','), bot_endpoint_id: cur.endpointId || newEndpointId() };
  if (pk) patch.bot_public_key = pk.toLowerCase();
  const { error } = await supabase.from('users').update(patch).eq('id', userId);
  if (error) throw userError(UNAVAILABLE, 503);
  return { registered: Boolean(tok) };
}

async function remove(userId) {
  const { error } = await supabase.from('users')
    .update({ bot_app_id: null, bot_public_key: null, bot_endpoint_id: null, bot_allowed_ids: null }).eq('id', userId);
  if (error) throw userError(UNAVAILABLE, 503);
}

/** The account behind an endpoint id (for the signature check), or null. Premium must still be active. */
async function findByEndpoint(endpointId) {
  if (!/^[0-9a-f]{32}$/.test(String(endpointId || ''))) return null;
  const { data: u, error } = await supabase.from('users').select('id').eq('bot_endpoint_id', endpointId).maybeSingle();
  if (error || !u) return null;
  try { await require('./shop').expirePremiums(u.id); } catch { /* shop not set up: ignore */ }
  const { data } = await supabase.from('users')
    .select('id, username, reseller, boost_price, bot_app_id, bot_public_key, bot_allowed_ids').eq('id', u.id).maybeSingle();
  if (!data || !data.reseller || !data.bot_public_key || !data.bot_app_id) return null;
  return {
    id: data.id, username: data.username, boost_price: data.boost_price,
    publicKey: data.bot_public_key, applicationId: data.bot_app_id, allowedIds: parseAllowedIds(data.bot_allowed_ids),
  };
}

module.exports = { parseAllowedIds, isAppId, isPublicKey, getConfig, save, remove, findByEndpoint, MAX_ALLOWED };
