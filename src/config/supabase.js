'use strict';

const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // We warn instead of throwing so the process can still boot in
  // environments where Supabase is intentionally not configured yet
  // (e.g. running the frontend against mocked data during development).
  console.warn(
    '[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
      'Database-backed routes will fail until they are configured.'
  );
}

// The service_role key bypasses Row Level Security. It must only ever be
// used on the server — never expose it to the browser.
const supabase = createClient(
  SUPABASE_URL || 'http://localhost',
  SUPABASE_SERVICE_ROLE_KEY || 'missing-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

module.exports = supabase;
