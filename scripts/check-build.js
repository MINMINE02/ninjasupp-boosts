'use strict';

/**
 * public/app.js, public/redeem.js and public/status.js are GENERATED from src/*.js
 * (javascript-obfuscator). Editing src/ without rebuilding leaves the site on old code.
 *
 *   node scripts/check-build.js          tells whether the generated files are out of date
 *   node scripts/check-build.js --write  records the sources the build was made from
 *                                        (run automatically at the end of `npm run build:js`)
 *   --strict                             exit with an error when out of date (for CI)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['src/app.js', 'src/redeem.js', 'src/status.js'];
const RECORD = path.join(ROOT, '.build-info.json');

const sha = (file) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

function current() {
  return Object.fromEntries(SOURCES.filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => [f, sha(f)]));
}

/** Returns the list of sources changed since the last build, or null when no build was recorded. */
function stale() {
  if (!fs.existsSync(RECORD)) return null;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(RECORD, 'utf8')).files || {}; } catch { return null; }
  const now = current();
  return Object.keys(now).filter((f) => saved[f] !== now[f]);
}

module.exports = { stale, current };

if (require.main === module) {
  const arg = process.argv.slice(2);
  if (arg.includes('--write')) {
    fs.writeFileSync(RECORD, JSON.stringify({ builtAt: new Date().toISOString(), files: current() }, null, 2) + '\n');
    console.log('[build] recorded the sources of this build');
  } else {
    const changed = stale();
    if (changed === null) {
      console.log('[build] no build recorded yet — run "npm run build:js" once.');
    } else if (changed.length) {
      console.error(`[build] OUT OF DATE: ${changed.join(', ')} changed since the last build. Run "npm run build:js".`);
      if (arg.includes('--strict')) process.exit(1);
    } else {
      console.log('[build] up to date');
    }
  }
}
