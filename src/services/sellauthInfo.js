'use strict';

// For a list of SellAuth deliveries: which were boosted DIRECTLY (no key handed
// out) and how their boost job is doing. Used by the admin and reseller lists.

const supabase = require('../config/supabase');

const DIRECT_SOURCE = 'sellauth-direct';

async function describe(deliveries) {
  const codes = [...new Set((deliveries || []).map((d) => d.key_code).filter(Boolean))];
  const out = new Map();
  if (!codes.length) return out;
  const { data: keys } = await supabase.from('redeem_keys').select('id, code, source').in('code', codes);
  const direct = (keys || []).filter((k) => k.source === DIRECT_SOURCE);
  if (!direct.length) return out;
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, key_id, status, boosts_requested, boosts_delivered')
    .in('key_id', direct.map((k) => k.id));
  const byKey = new Map((jobs || []).map((j) => [j.key_id, j]));
  for (const k of direct) {
    const j = byKey.get(k.id);
    out.set(k.code, {
      direct: true,
      jobId: j ? j.id : null,
      jobStatus: j ? j.status : null,
      delivered: j ? j.boosts_delivered : null,
      requested: j ? j.boosts_requested : null,
    });
  }
  return out;
}

module.exports = { describe, DIRECT_SOURCE };
