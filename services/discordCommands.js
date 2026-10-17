'use strict';

/* Slash commands of the Ninja Boost bot (registered by scripts/register-discord-commands.js).
 * The same commands serve admins (the platform) and linked premium accounts (their own stock);
 * who may run what is decided by the server, not by Discord permissions.
 * Option types: 3 = string, 4 = integer, 11 = attachment. */

const STRING = 3;
const INTEGER = 4;
const ATTACHMENT = 11;

const commands = [
  {
    name: 'stock',
    description: 'Your token stock: unused, used and boosts available',
  },
  {
    name: 'restock',
    description: 'Add tokens to your stock (paste them or attach a .txt file)',
    options: [
      { type: STRING, name: 'tokens', description: 'Tokens, one per line (email:pass:token or token)', max_length: 6000 },
      { type: ATTACHMENT, name: 'file', description: 'A .txt file with one token per line (up to 5000)' },
    ],
  },
  {
    name: 'genkey',
    description: 'Generate redeem keys',
    options: [
      { type: INTEGER, name: 'boosts', description: 'Boosts each key is worth', required: true, min_value: 1, max_value: 1000 },
      { type: INTEGER, name: 'count', description: 'How many keys (default 1, max 100)', min_value: 1, max_value: 100 },
      { type: STRING, name: 'note', description: 'A note to find these keys later (e.g. giveaway)', max_length: 120 },
    ],
  },
  {
    name: 'boost',
    description: 'Boost a server right now with your stock (no key needed)',
    options: [
      { type: STRING, name: 'invite', description: 'Server invite link or code', required: true, max_length: 200 },
      { type: INTEGER, name: 'boosts', description: 'How many boosts', required: true, min_value: 1, max_value: 1000 },
    ],
  },
  {
    name: 'job',
    description: 'Progress of one boost job',
    options: [{ type: STRING, name: 'id', description: 'Job id', required: true, max_length: 60 }],
  },
  {
    name: 'jobs',
    description: 'Your latest boost jobs',
    options: [{ type: INTEGER, name: 'count', description: 'How many (default 5, max 10)', min_value: 1, max_value: 10 }],
  },
  {
    name: 'key',
    description: 'Look up a redeem key (value, delivered, server, owner)',
    options: [{ type: STRING, name: 'code', description: 'The 16-character key', required: true, max_length: 40 }],
  },
  {
    name: 'revoke',
    description: 'Delete an unused platform key',
    options: [{ type: STRING, name: 'code', description: 'The 16-character key', required: true, max_length: 40 }],
  },
  {
    name: 'balance',
    description: 'Salta7 account balance',
  },
  {
    name: 'link',
    description: 'Premium: link this Discord account to your premium account (code from your panel)',
    options: [{ type: STRING, name: 'code', description: 'The code shown in your panel (API tab → Shared bot)', required: true, max_length: 20 }],
  },
  {
    name: 'unlink',
    description: 'Premium: unlink this Discord account from your premium account',
  },
].map((c) => ({
  ...c,
  dm_permission: false,
  // Visible to everybody on purpose: premium accounts are not server administrators.
  // The real gate is on the server: DISCORD_ADMIN_IDS (platform) or a linked, active premium account.
}));

// A premium account's own bot: no /link or /unlink (nothing to link), and hidden from non-administrators by default.
const personalCommands = commands
  .filter((c) => c.name !== 'link' && c.name !== 'unlink')
  .map((c) => ({ ...c, dm_permission: false, default_member_permissions: '8' }));

module.exports = { commands, personalCommands };
