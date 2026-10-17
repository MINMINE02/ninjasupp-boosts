'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const dp = require('../services/discordPremium');

test('link codes are readable and normalised', () => {
  const code = dp.newCode();
  assert.match(code, /^NB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(dp.normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code);
  assert.equal(dp.normalizeCode('NBABCDEFGH'), 'NB-ABCD-EFGH');
});

test('anything that is not a code is rejected', () => {
  assert.equal(dp.normalizeCode(''), '');
  assert.equal(dp.normalizeCode('NB-ABC'), '');
  assert.equal(dp.normalizeCode('NB-0OIL-1111'), '');   // ambiguous characters are never used
});

test('only the hash of a code is stored', () => {
  assert.notEqual(dp.hash('NB-ABCD-EFGH'), 'NB-ABCD-EFGH');
  assert.equal(dp.hash('NB-ABCD-EFGH'), dp.hash('NB-ABCD-EFGH'));
});
