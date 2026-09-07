'use strict';

const supabase = require('../config/supabase');

/**
 * Admin-configurable settings with sensible env-backed defaults.
 * Currently: the BYOT solve price the admin can tune from the dashboard.
 *
 *   - captcha_cost : solve price charged per captcha in BYOT mode
 */
const DEFAULTS = {
  captcha_cost: Number(process.env.CAPTCHA_COST || 0.015),
};

const ALLOWED_KEYS = Object.keys(DEFAULTS);

let cache = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5000;

async function getSettings() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_TTL_MS) return cache;

  const result = { ...DEFAULTS };
  try {
    const { data } = await supabase.from('settings').select('key, value');
    if (Array.isArray(data)) {
      for (const row of data) {
        if (ALLOWED_KEYS.includes(row.key)) {
          result[row.key] = Number(row.value);
        }
      }
    }
  } catch {
    // Table missing / DB unavailable -> fall back to defaults.
  }

  cache = result;
  cachedAt = now;
  return result;
}

async function updateSettings(patch = {}) {
  const rows = [];
  for (const key of ALLOWED_KEYS) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === '') continue;

    const value = Number(raw);
    if (Number.isNaN(value) || value < 0) {
      const err = new Error(`Invalid value for "${key}"`);
      err.status = 400;
      throw err;
    }
    rows.push({ key, value, updated_at: new Date().toISOString() });
  }

  if (rows.length === 0) {
    const err = new Error('No valid settings provided');
    err.status = 400;
    throw err;
  }

  const { error } = await supabase
    .from('settings')
    .upsert(rows, { onConflict: 'key' });
  if (error) throw error;

  cache = null; // invalidate so the next read reflects the change
  return getSettings();
}

module.exports = { getSettings, updateSettings, DEFAULTS, ALLOWED_KEYS };
