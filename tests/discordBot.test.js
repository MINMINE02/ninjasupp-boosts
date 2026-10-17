'use strict';
process.env.DISCORD_ADMIN_IDS = '900000001';
global.__fakeDb = require('./_fakeDb')({
  users: [
    { id: 'u1', username: 'alice', reseller: true, discord_id: '111111', balance: 5, boost_price: 0.1 },
    { id: 'u2', username: 'bob', reseller: true, discord_id: null },
    { id: 'u3', username: 'carol', reseller: false, discord_id: '333333' },   // premium ended
  ],
  stock_tokens: [
    { id: 't1', owner_id: 'u1', status: 'unused' }, { id: 't2', owner_id: 'u1', status: 'unused' },
    { id: 't3', owner_id: 'u1', status: 'used' },
    { id: 't4', owner_id: 'u2', status: 'unused' }, { id: 't5', owner_id: 'u2', status: 'unused' }, { id: 't6', owner_id: 'u2', status: 'unused' },
    { id: 't7', owner_id: null, status: 'unused' },
  ],
  redeem_keys: [
    { id: 'k1', code: 'AAAAAAAAAAAAAAAA', owner_id: 'u1', boosts_value: 2, boosts_delivered: 0, redeemed_at: null },
    { id: 'k2', code: 'BBBBBBBBBBBBBBBB', owner_id: 'u2', boosts_value: 2, boosts_delivered: 0, redeemed_at: null },
  ],
  jobs: [
    { id: 'j1', owner_id: 'u1', mode: 'key', invite: 'mine', status: 'completed', boosts_requested: 2, boosts_delivered: 2, created_at: new Date().toISOString() },
    { id: 'j2', owner_id: 'u2', mode: 'key', invite: 'theirs', status: 'completed', boosts_requested: 2, boosts_delivered: 2, created_at: new Date().toISOString() },
  ],
});
require('./_setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../services/discordBot');

const call = async (discordId, name, options = {}) => {
  const { response } = await bot.handleInteraction({
    type: 2, member: { user: { id: discordId } },
    data: { name, options: Object.entries(options).map(([k, value]) => ({ name: k, value })) },
  });
  return response.data;
};
const text = (d) => JSON.stringify(d);
const unusedOf = (d) => d.embeds[0].fields.find((f) => f.name.includes('Unused tokens')).value;

test('a premium account sees only its own stock', async () => {
  assert.equal(unusedOf(await call('111111', 'stock')), '2');
});

test('an admin sees the platform stock', async () => {
  const d = await call('900000001', 'stock');
  assert.equal(unusedOf(d), '1');
});

test('someone who is not linked is told to link first', async () => {
  assert.match(text(await call('555555', 'stock')), /Link your premium account first/);
  assert.match(text(await call('555555', 'boost', { invite: 'abc', boosts: 2 })), /Link your premium account first/);
});

test('a premium account that ended is refused', async () => {
  assert.match(text(await call('333333', 'stock')), /Link your premium account first/);
});

test('a premium account cannot read someone else\'s key', async () => {
  assert.match(text(await call('111111', 'key', { code: 'BBBBBBBBBBBBBBBB' })), /Key not found/);
  assert.match(text(await call('111111', 'key', { code: 'AAAAAAAAAAAAAAAA' })), /AAAAAAAAAAAAAAAA/);
});

test('a premium account cannot revoke someone else\'s key', async () => {
  assert.match(text(await call('111111', 'revoke', { code: 'BBBBBBBBBBBBBBBB' })), /Key not found/);
});

test('/jobs only lists the caller\'s own jobs', async () => {
  const out = text(await call('111111', 'jobs'));
  assert.match(out, /mine/);
  assert.doesNotMatch(out, /theirs/);
});

test('/job refuses another account\'s job', async () => {
  assert.match(text(await call('111111', 'job', { id: '00000000-0000-4000-8000-000000000000' })), /Job not found/);
});

test('/balance shows the premium wallet, not the Salta7 balance', async () => {
  const out = text(await call('111111', 'balance'));
  assert.match(out, /Your wallet/);
  assert.match(out, /\$5\.00/);
});
