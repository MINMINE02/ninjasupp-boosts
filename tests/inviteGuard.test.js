'use strict';
require('./_setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../services/inviteGuard');

const inv = (features = [], extra = {}) => ({ guild: { features }, ...extra });

test('a normal server is joinable', () => {
  assert.equal(evaluate(inv(['COMMUNITY'])), null);
  assert.equal(evaluate(null), null);
});

test('paused invites are refused', () => {
  assert.equal(evaluate(inv(['INVITES_DISABLED'])).code, 'INVITES_PAUSED');
});

test('"Apply to join" is refused', () => {
  assert.equal(evaluate(inv(['MEMBER_VERIFICATION_MANUAL_APPROVAL'])).code, 'APPLY_TO_JOIN');
});

test('rules screening is refused by default', () => {
  assert.equal(evaluate(inv(['MEMBER_VERIFICATION_GATE_ENABLED'])).code, 'RULES_SCREENING');
});

test('an expired invite is refused', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(evaluate(inv([], { expires_at: past })).code, 'INVITE_INVALID');
  const future = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(evaluate(inv([], { expires_at: future })), null);
});
