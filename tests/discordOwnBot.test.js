'use strict';
process.env.DISCORD_ADMIN_IDS = '900000001';
global.__fakeDb = require('./_fakeDb')({
  users: [
    { id: 'u1', username: 'alice', reseller: true, balance: 5, boost_price: 0.1 },
    { id: 'u2', username: 'bob', reseller: true },
  ],
  stock_tokens: [
    { id: 't1', owner_id: 'u1', status: 'unused' }, { id: 't2', owner_id: 'u1', status: 'unused' },
    { id: 't3', owner_id: 'u2', status: 'unused' }, { id: 't4', owner_id: 'u2', status: 'unused' }, { id: 't5', owner_id: 'u2', status: 'unused' },
    { id: 't6', owner_id: null, status: 'unused' },
  ],
  redeem_keys: [
    { id: 'k1', code: 'AAAAAAAAAAAAAAAA', owner_id: 'u1', boosts_value: 2, boosts_delivered: 0 },
    { id: 'k2', code: 'BBBBBBBBBBBBBBBB', owner_id: 'u2', boosts_value: 2, boosts_delivered: 0 },
  ],
  jobs: [],
});
require('./_setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const bot = require('../services/discordBot');
const own = require('../services/discordOwnBot');

const alice = { id: 'u1', username: 'alice', boost_price: 0.1, applicationId: '777777777777777777', allowedIds: ['111111'] };
const call = async (userId, name, options = {}, appId = '777777777777777777') => {
  const { response } = await bot.handleOwnedInteraction({
    type: 2, application_id: appId, member: { user: { id: userId } },
    data: { name, options: Object.entries(options).map(([k, value]) => ({ name: k, value })) },
  }, alice);
  return JSON.stringify(response.data);
};

test('an allowed user runs the commands on the owner\'s own stock', async () => {
  const out = await call('111111', 'stock');
  assert.match(out, /Your token stock/);
  assert.match(out, /"value":"2"/);          // alice has 2 unused tokens, not bob's 3 nor the platform's 1
});

test('a user who is not in the allowed list is refused', async () => {
  assert.match(await call('222222', 'stock'), /not allowed/);
});

test('another application cannot use this account\'s endpoint', async () => {
  assert.match(await call('111111', 'stock', {}, '888888888888888888'), /not set up/);
});

test('the account cannot see another account\'s key through its own bot', async () => {
  assert.match(await call('111111', 'key', { code: 'BBBBBBBBBBBBBBBB' }), /Key not found/);
});

test('/link and /unlink do not exist on a personal bot', async () => {
  assert.match(await call('111111', 'link', { code: 'NB-ABCD-EFGH' }), /Unknown command/);
});

test('a PING is answered', async () => {
  const { response } = await bot.handleOwnedInteraction({ type: 1 }, alice);
  assert.deepEqual(response, { type: 1 });
});

test('allowed ids: only real Discord ids, no duplicates, capped', () => {
  assert.deepEqual(own.parseAllowedIds('111111, abc 222222;111111'), ['111111', '222222']);
  assert.equal(own.parseAllowedIds(Array.from({ length: 50 }, (_, i) => String(100000 + i))).length, own.MAX_ALLOWED);
});

test('application id and public key are validated', () => {
  assert.equal(own.isAppId('123456789012345678'), true);
  assert.equal(own.isAppId('abc'), false);
  assert.equal(own.isPublicKey('a'.repeat(64)), true);
  assert.equal(own.isPublicKey('xyz'), false);
});

test('saving without a token is refused the first time (nothing would register the commands)', async () => {
  await assert.rejects(
    () => own.save('u1', { appId: '123456789012345678', publicKey: 'a'.repeat(64), allowedIds: '111111' }),
    /bot token/i,
  );
});

test('saving without any allowed user id is refused', async () => {
  await assert.rejects(
    () => own.save('u1', { appId: '123456789012345678', publicKey: 'a'.repeat(64), token: 'x', allowedIds: '' }),
    /Discord user id/,
  );
});
