'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInviteCode, extractToken, parseCredentialList } = require('../utils/helpers');

test('parseInviteCode accepts links and bare codes', () => {
  assert.equal(parseInviteCode('https://discord.gg/example'), 'example');
  assert.equal(parseInviteCode('discord.com/invite/abc-123'), 'abc-123');
  assert.equal(parseInviteCode('  example/ '), 'example');
  assert.equal(parseInviteCode(''), '');
  assert.equal(parseInviteCode(null), '');
});

const FAKE_TOKEN = 'FAKEFAKEFAKEFAKEFAKE.FAKEFAK.fakefakefakefakefakefake1';
const FAKE_2FA = 'JBSWY3DPEHPK3PXP';

test('extractToken reads bare tokens and email:pass:token lines', () => {
  assert.equal(extractToken(FAKE_TOKEN), FAKE_TOKEN);
  assert.equal(extractToken(`a@b.c:hunter2:${FAKE_TOKEN}`), FAKE_TOKEN);
});

test('extractToken pulls the token out of email:pass:token:2fa, not the trailing 2FA code', () => {
  assert.equal(extractToken(`a@b.c:hunter2:${FAKE_TOKEN}:${FAKE_2FA}`), FAKE_TOKEN);
});

test('parseCredentialList keeps the full line (incl. 2FA) alongside the extracted token', () => {
  const line = `a@b.c:hunter2:${FAKE_TOKEN}:${FAKE_2FA}`;
  const out = parseCredentialList(line);
  assert.deepEqual(out, [{ token: FAKE_TOKEN, line }]);
});

test('email:pass:token:2fa — the 2FA part is never taken for the token', () => {
  const { extractToken, formatCredential } = require('../utils/helpers');
  const T = 'FAKEFAKEFAKEFAKEFAKE.FAKEFAK.fakefakefakefakefakefake2';
  assert.equal(extractToken(`a@b.c:pw:${T}:JBSWY3DPEHPK3PXP`), T);
  assert.equal(extractToken(`a@b.c:pw:${T}:123456`), T);
  assert.equal(extractToken('a@b.c:pw:oddtokenvalue123:123456'), 'oddtokenvalue123'); // unusual token shape
  assert.equal(extractToken('a@b.c:pw:oddtokenvalue123'), 'oddtokenvalue123');
  const row = { token: T, full_line: `a@b.c:pw:${T}:JBSWY3DPEHPK3PXP` };
  assert.equal(formatCredential(row, 'full'), row.full_line);
  assert.equal(formatCredential(row, 'email_pass_token'), `a@b.c:pw:${T}`);
  assert.equal(formatCredential(row, 'token'), T);
  assert.equal(formatCredential({ token: T, full_line: null }, 'full'), T);
});
