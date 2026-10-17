'use strict';

/**
 * Stock repair — re-derives each token from the full line it was added with.
 *
 * Lines like `email:pass:token:2fa` used to be stored with the trailing 2FA code as the
 * "token" when the token had an unusual shape; the checker and the boosts then sent that
 * wrong value. This re-reads `full_line` with the current token detection and fixes the
 * `token` column where it differs. Only this owner's rows are touched (ownerId null = the
 * platform's pool); a token that would collide with an existing one is left alone.
 */
const supabase = require('../config/supabase');
const { extractToken } = require('../utils/helpers');
const { fetchAll } = require('../utils/stockExport');

async function repairStock(ownerId) {
  const rows = await fetchAll(() => {
    let q = supabase.from('stock_tokens').select('id, token, full_line')
      .not('full_line', 'is', null).order('created_at').order('id');
    q = ownerId ? q.eq('owner_id', ownerId) : q.is('owner_id', null);
    return q;
  });
  let fixed = 0;
  let conflicts = 0;
  for (const r of rows) {
    const bare = extractToken(r.full_line);
    if (!bare || bare === r.token) continue;
    const { error } = await supabase.from('stock_tokens').update({ token: bare }).eq('id', r.id);
    if (error) conflicts += 1; else fixed += 1;
  }
  return { scanned: rows.length, fixed, conflicts };
}

module.exports = { repairStock };
