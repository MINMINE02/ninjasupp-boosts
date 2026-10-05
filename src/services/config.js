'use strict';

const supabase = require('../config/supabase');

/**
 * Tiny key/value store for admin-configurable text settings (the numeric
 * `settings` table can't hold strings). Currently used for the support
 * contact link.
 */
async function getConfig(key) {
  try {
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    return data?.value ?? null;
  } catch {
    return null;
  }
}

async function setConfig(key, value) {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

module.exports = { getConfig, setConfig };
