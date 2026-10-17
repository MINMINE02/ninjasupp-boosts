'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const shop = require('../services/shop');

const order = { price_usd: 10 };

test('missingUsd: nothing received -> the full price', () => {
  assert.equal(shop.missingUsd(order, { usd_amount: 10, amount: 0.1, received: 0 }), 10);
  assert.equal(shop.missingUsd(order, null), 10);
});

test('missingUsd: a short payment leaves the difference', () => {
  assert.equal(shop.missingUsd(order, { usd_amount: 10, amount: 0.1, received: 0.06 }), 4);
});

test('missingUsd: a few cents of drift count as paid', () => {
  assert.equal(shop.missingUsd(order, { usd_amount: 10, amount: 0.1, received: 0.0999 }), 0);
  assert.equal(shop.missingUsd(order, { usd_amount: 10, amount: 0.1, received: 0.1 }), 0);
});

test('missingUsd: a top-up deposit only covers what was missing', () => {
  // first payment covered $6, the top-up deposit was made for the remaining $4 and $3 arrived
  assert.equal(shop.missingUsd(order, { usd_amount: 4, amount: 0.04, received: 0.03 }), 1);
});

test('premiumPatch: lifetime stays lifetime, renewals stack', () => {
  const now = Date.UTC(2026, 0, 1);
  const day = 86_400_000;
  const lifetime = shop.premiumPatch({ reseller: true, premium_until: null }, { premium_days: 30 }, now);
  assert.equal(lifetime.premium_until, null);

  const stacked = shop.premiumPatch({ reseller: true, premium_until: new Date(now + 10 * day).toISOString() }, { premium_days: 30 }, now);
  assert.equal(new Date(stacked.premium_until).getTime(), now + 40 * day);

  const fresh = shop.premiumPatch({ reseller: false }, { premium_days: 30 }, now);
  assert.equal(new Date(fresh.premium_until).getTime(), now + 30 * day);
});
