'use strict';

/**
 * Invite guard — look at a Discord invite BEFORE a key is spent and refuse
 * the servers our accounts cannot join (or cannot boost after joining):
 *
 *   - invite expired / invalid / deleted            (Discord answers 404)
 *   - invites paused on the server                  (INVITES_DISABLED)
 *   - "Apply to join" / manual approval             (MEMBER_VERIFICATION_MANUAL_APPROVAL)
 *   - rules screening — accounts stay "pending"     (MEMBER_VERIFICATION_GATE_ENABLED)
 *
 * The lookup FAILS OPEN: if Discord is unreachable or rate-limits us, the
 * redeem goes ahead as before (we never block a customer on our own outage).
 *
 * Env:
 *   INVITE_GUARD=off               disable the whole guard
 *   BLOCK_RULES_SCREENING=false    let "rules screening" servers through
 */

const CACHE_MS = 60_000;
const cache = new Map(); // code -> { at, result }

const GUARD_ON = String(process.env.INVITE_GUARD || 'on').toLowerCase() !== 'off';
const BLOCK_SCREENING = String(process.env.BLOCK_RULES_SCREENING || 'true').toLowerCase() !== 'false';

const MESSAGES = {
  INVITE_INVALID: 'This invite is invalid or has expired. Create a new permanent invite and try again — your key was not used.',
  INVITES_PAUSED: 'Invites are paused on this server, so nobody can join it. Re-enable invites and try again — your key was not used.',
  APPLY_TO_JOIN: 'This server uses "Apply to join" (manual approval), so our accounts cannot join it. Turn it off, then try again — your key was not used.',
  RULES_SCREENING: 'This server requires accepting rules (membership screening) before members can act, so the boost cannot be applied. Turn it off, then try again — your key was not used.',
};

/** Pure check on a Discord invite payload. Returns null when the server looks joinable. */
function evaluate(data) {
  if (!data || typeof data !== 'object') return null;
  const features = Array.isArray(data.guild?.features) ? data.guild.features : [];

  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return { code: 'INVITE_INVALID', message: MESSAGES.INVITE_INVALID };
  }
  if (features.includes('INVITES_DISABLED')) {
    return { code: 'INVITES_PAUSED', message: MESSAGES.INVITES_PAUSED };
  }
  if (features.includes('MEMBER_VERIFICATION_MANUAL_APPROVAL')) {
    return { code: 'APPLY_TO_JOIN', message: MESSAGES.APPLY_TO_JOIN };
  }
  if (BLOCK_SCREENING && features.includes('MEMBER_VERIFICATION_GATE_ENABLED')) {
    return { code: 'RULES_SCREENING', message: MESSAGES.RULES_SCREENING };
  }
  return null;
}

/**
 * Looks the invite up. Resolves to:
 *   { ok: true }                                  — joinable, or lookup unavailable (fail open)
 *   { ok: false, code, message }                  — refuse, show `message` to the customer
 */
async function inspect(code) {
  if (!GUARD_ON || !code) return { ok: true };

  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  let result = { ok: true };
  try {
    const r = await fetch(
      `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`,
      { headers: { 'User-Agent': 'Ninja Boost (https://ninja-boost, 1.0)' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.status === 404) {
      result = { ok: false, code: 'INVITE_INVALID', message: MESSAGES.INVITE_INVALID };
    } else if (r.ok) {
      const problem = evaluate(await r.json());
      if (problem) result = { ok: false, ...problem };
    }
    // 429 / 5xx -> fail open, and do not cache so the next try asks Discord again.
    else return result;
  } catch {
    return result; // network error / timeout -> fail open
  }

  if (cache.size > 2000) cache.clear();
  cache.set(code, { at: Date.now(), result });
  return result;
}

module.exports = { inspect, evaluate };
