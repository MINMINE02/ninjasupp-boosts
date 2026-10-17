'use strict';

/* Registers the slash commands of the admin bot with Discord.
 *
 *   node scripts/register-discord-commands.js
 *
 * Needs in the environment (.env is read if present):
 *   DISCORD_APP_ID      Application ID
 *   DISCORD_BOT_TOKEN   Bot token (only used here, never by the server)
 *   DISCORD_GUILD_ID    optional: register in ONE server (instant, recommended for an admin bot).
 *                       Without it the commands are global (can take up to an hour to appear).
 * Re-run it whenever services/discordCommands.js changes: it replaces the whole list. */

try {
  require('dotenv').config();
  require('dotenv').config({ path: require('path').join(__dirname, '..', 'discord.env') });
} catch { /* dotenv is optional here */ }
const { commands } = require('../services/discordCommands');

async function main() {
  const { DISCORD_APP_ID: app, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
  if (!app || !token) {
    console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN first.');
    process.exit(1);
  }
  const url = guild
    ? `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`
    : `https://discord.com/api/v10/applications/${app}/commands`;
  const res = await fetch(url, {
    method: 'PUT', // replaces every command of this scope with exactly this list
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`Discord answered ${res.status}:\n${body}`);
    process.exit(1);
  }
  console.log(`Registered ${commands.length} commands ${guild ? `in server ${guild}` : 'globally'}: ${commands.map((c) => '/' + c.name).join(' ')}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
