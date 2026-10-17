'use strict';

// Link embed of the MAIN site (set by the admin). Stored in app_config; short
// cache so crawlers and visitors don't hit the database on every request.

const supabase = require('../config/supabase');
const { setConfig } = require('./config');
const E = require('./embed');

const TTL_MS = 15_000;
let cache = null;

async function load() {
  const { data, error } = await supabase.from('app_config').select('key, value').in('key', E.SITE_KEYS);
  const m = Object.fromEntries((error ? [] : data || []).map((r) => [r.key, r.value || '']));
  return {
    siteName: m.embed_site || '',
    title: m.embed_title || '',
    description: m.embed_description || '',
    color: E.colour(m.embed_color),
    image: m.embed_image || '',
  };
}

async function get() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value;
  try { value = await load(); } catch { value = { siteName: '', title: '', description: '', color: '', image: '' }; }
  cache = { at: Date.now(), value };
  return value;
}

// What actually gets shown: custom values, falling back to the defaults.
async function effective() {
  const c = await get();
  return {
    siteName: c.siteName || E.DEFAULT_SITE.siteName,
    title: c.title || E.DEFAULT_SITE.title,
    description: c.description || E.DEFAULT_SITE.description,
    color: c.color || E.DEFAULT_SITE.color,
    image: c.image,
  };
}

async function save(patch) {
  const map = { siteName: 'embed_site', title: 'embed_title', description: 'embed_description', color: 'embed_color', image: 'embed_image' };
  for (const [k, key] of Object.entries(map)) {
    if (patch[k] !== undefined) await setConfig(key, patch[k]);
  }
  cache = null;
}

const clear = () => { cache = null; };

module.exports = { get, effective, save, clear };
