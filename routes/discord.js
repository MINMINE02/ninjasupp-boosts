'use strict';

// POST /api/discord/interactions — the "Interactions Endpoint URL" of the Discord application.
// The body is verified against DISCORD_PUBLIC_KEY (raw bytes kept by the JSON parser in server.js).

const express = require('express');
const bot = require('../services/discordBot');

const router = express.Router();

router.post('/interactions', async (req, res) => {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) return res.status(503).json({ error: 'DISCORD_PUBLIC_KEY is not set on the server' });

  const ok = bot.verifySignature(req.rawBody, req.get('X-Signature-Ed25519'), req.get('X-Signature-Timestamp'), publicKey);
  if (!ok) return res.status(401).send('invalid request signature'); // Discord checks that this is refused

  let out;
  try {
    out = await bot.handleInteraction(req.body);
  } catch (err) {
    console.error('[discord] interaction failed:', err.message);
    return res.json({ type: 4, data: { flags: 64, content: '❌ Something went wrong — check the server logs.' } });
  }
  res.json(out.response);
  if (out.after) out.after().catch(() => {}); // hosts that keep running: finish a slow command, then edit the message
});

// POST /api/discord/u/:endpointId/interactions — the Interactions Endpoint URL of a PREMIUM account's own
// Discord application. The request is verified with THAT account's public key, so one account's bot can
// never act for another.
router.post('/u/:endpointId/interactions', async (req, res) => {
  let owner = null;
  try { owner = await require('../services/discordOwnBot').findByEndpoint(req.params.endpointId); } catch { owner = null; }
  if (!owner) return res.status(404).json({ error: 'Not found' });

  const ok = bot.verifySignature(req.rawBody, req.get('X-Signature-Ed25519'), req.get('X-Signature-Timestamp'), owner.publicKey);
  if (!ok) return res.status(401).send('invalid request signature');

  let out;
  try {
    out = await bot.handleOwnedInteraction(req.body, owner);
  } catch (err) {
    console.error('[discord] own-bot interaction failed:', err.message);
    return res.json({ type: 4, data: { flags: 64, content: '❌ Something went wrong — try again later.' } });
  }
  res.json(out.response);
  if (out.after) out.after().catch(() => {});
});

module.exports = router;
