'use strict';
// End-to-end check of POST /api/discord/u/:endpointId/interactions with a real Ed25519 signature.
const crypto = require('crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const other = crypto.generateKeyPairSync('ed25519');

const ENDPOINT = 'a'.repeat(32);
global.__fakeDb = require('./_fakeDb')({
  users: [
    { id: 'u1', username: 'alice', reseller: true, boost_price: 0.1, bot_endpoint_id: ENDPOINT, bot_app_id: '777777777777777777', bot_public_key: pubHex, bot_allowed_ids: '111111' },
    { id: 'u9', username: 'ended', reseller: false, bot_endpoint_id: 'b'.repeat(32), bot_app_id: '777777777777777778', bot_public_key: pubHex, bot_allowed_ids: '111111' },
  ],
  stock_tokens: [{ id: 't1', owner_id: 'u1', status: 'unused' }, { id: 't2', owner_id: 'u2', status: 'unused' }],
  redeem_keys: [], jobs: [],
});
require('./_setup');

// express is not needed here: capture the handler the router registers.
const Module = require('module');
const origLoad = Module._load;
const handlers = {};
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({ post: (path, h) => { handlers[path] = h; } }) };
  return origLoad.call(this, request, ...rest);
};
require('../routes/discord');
const handler = handlers['/u/:endpointId/interactions'];

const test = require('node:test');
const assert = require('node:assert/strict');

function signed(body, key = privateKey, ts = String(Math.floor(Date.now() / 1000))) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = crypto.sign(null, Buffer.concat([Buffer.from(ts), raw]), key).toString('hex');
  return { rawBody: raw, body, get: (h) => ({ 'x-signature-ed25519': sig, 'x-signature-timestamp': ts })[h.toLowerCase()] };
}
async function post(endpointId, req) {
  const out = { status: 200, json: null, text: null };
  const res = { status(c) { out.status = c; return res; }, json(j) { out.json = j; return res; }, send(t) { out.text = t; return res; } };
  await handler({ ...req, params: { endpointId } }, res);
  return out;
}
const cmd = (name, user = '111111', app = '777777777777777777') => ({
  type: 2, application_id: app, member: { user: { id: user } }, data: { name, options: [] },
});

test('Discord\'s verification PING is answered', async () => {
  const out = await post(ENDPOINT, signed({ type: 1 }));
  assert.deepEqual(out.json, { type: 1 });
});

test('a signed command runs on the account\'s own stock', async () => {
  const out = await post(ENDPOINT, signed(cmd('stock')));
  assert.equal(out.status, 200);
  assert.match(JSON.stringify(out.json), /Your token stock/);
  assert.match(JSON.stringify(out.json), /"value":"1"/);
});

test('a request signed with another key is refused', async () => {
  const out = await post(ENDPOINT, signed(cmd('stock'), other.privateKey));
  assert.equal(out.status, 401);
});

test('an old (replayed) request is refused', async () => {
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const out = await post(ENDPOINT, signed(cmd('stock'), privateKey, old));
  assert.equal(out.status, 401);
});

test('an unknown endpoint is a 404', async () => {
  assert.equal((await post('c'.repeat(32), signed({ type: 1 }))).status, 404);
  assert.equal((await post('not-an-id', signed({ type: 1 }))).status, 404);
});

test('a premium that ended no longer has a working bot', async () => {
  assert.equal((await post('b'.repeat(32), signed({ type: 1 }))).status, 404);
});
