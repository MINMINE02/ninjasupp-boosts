'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { reusableLines } = require('../services/checker');

test('only valid tokens with a free boost slot are put back', () => {
  const out = reusableLines([
    { item_data: 'AAA', status: 'valid', boost_free: 2 },
    { item_data: 'BBB', status: 'valid', boost_free: 0 },     // still carrying its boosts
    { item_data: 'CCC', status: 'valid', boost_free: null },  // unknown -> not trusted
    { item_data: 'DDD', status: 'invalid', boost_free: 2 },
    { item_data: 'EEE', status: 'locked', boost_free: 2 },
  ]);
  assert.deepEqual(out, ['AAA']);
});

test('pasted email:pass:token lines are reduced to the token, without duplicates', () => {
  const out = reusableLines([
    { item_data: 'a@b.c:pw:TOKEN.ONE.xyz', status: 'valid', boost_free: 1 },
    { item_data: 'TOKEN.ONE.xyz', status: 'valid', boost_free: 1 },
  ]);
  assert.deepEqual(out, ['TOKEN.ONE.xyz']);
});
