'use strict';

// Public branding of a reseller's redeem page (/r/<slug>): title, support
// link, header name, icon and accent colour. Short in-memory cache so a busy
// page doesn't hit the database on every visit.

const supabase = require('../config/supabase');
const theme = require('../public/theme.js');

const TTL_MS = 15_000;
const cache = new Map(); // slug -> { at, value }

const BASE = 'redeem_title, support_url, reseller';
const FULL = `${BASE}, redeem_brand, redeem_color, redeem_icon`;

async function load(slug) {
  let { data, error } = await supabase.from('users').select(FULL).eq('redeem_slug', slug).maybeSingle();
  // Branding migration not run yet -> serve the page without colour/icon/name.
  if (error) ({ data, error } = await supabase.from('users').select(BASE).eq('redeem_slug', slug).maybeSingle());
  if (error || !data || !data.reseller) return null;
  return {
    title: data.redeem_title || '',
    supportUrl: data.support_url || '',
    brand: data.redeem_brand || '',
    color: theme.parse(data.redeem_color) || '',
    icon: data.redeem_icon || '',
  };
}

async function get(slug) {
  slug = String(slug || '').toLowerCase();
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load(slug);
  if (cache.size > 500) cache.clear();
  cache.set(slug, { at: Date.now(), value });
  return value;
}

const clear = () => cache.clear();

module.exports = { get, clear };
