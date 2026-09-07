'use strict';

const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');

/**
 * Ensures a bootstrap admin account exists so the platform is usable on a
 * fresh database. Controlled by ADMIN_USERNAME / ADMIN_PASSWORD.
 *
 * This must NOT rely on server start-up: on serverless hosts (e.g. Vercel)
 * `app.listen()` never runs, so we seed lazily on the first auth request
 * instead — see `ensureAdminOnce()`.
 */
async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  // .env.example ships literal placeholder values ("admin" / "changeme") as
  // a template to fill in, not something to actually deploy with — refuse
  // to seed an admin account with them so a real deployment can't end up
  // running on a publicly-known credential.
  if (password === 'changeme') {
    throw new Error(
      'ADMIN_PASSWORD is still set to the placeholder "changeme" from ' +
      '.env.example. Set a real, unique password before starting the server.'
    );
  }

  // The env credentials are only a first-run bootstrap seed. If ANY admin
  // account already exists we leave it untouched — otherwise an admin who
  // changed their username/password from the dashboard would find the old
  // env-based admin recreated (or reset) on the next cold start. So the
  // seed runs only when there is no admin at all.
  const { data: existingAdmin } = await supabase
    .from('users')
    .select('id')
    .eq('role', 'admin')
    .limit(1)
    .maybeSingle();

  if (existingAdmin) return;

  const password_hash = await bcrypt.hash(String(password), 10);
  const { error } = await supabase
    .from('users')
    .insert({ username, password_hash, role: 'admin' });

  // A concurrent instance may have inserted the same admin first — that's fine.
  if (error && !/duplicate|unique/i.test(error.message || '')) throw error;

  console.log(`[bootstrap] Ensured admin user "${username}"`);
}

let adminPromise = null;

/**
 * Runs ensureAdmin() at most once per warm instance. On failure the cached
 * promise is cleared so a later request retries.
 */
function ensureAdminOnce() {
  if (!adminPromise) {
    adminPromise = ensureAdmin().catch((err) => {
      adminPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return adminPromise;
}

module.exports = { ensureAdmin, ensureAdminOnce };
