'use strict';

/* =========================================================================
 * Public, READ-ONLY progress of a direct SellAuth boost — GET /api/status/:id
 * (the page /status/<job id> polls it).
 *
 *  - The job id is a random UUID: only someone who got the buyer's message has it.
 *  - Only jobs created by a direct SellAuth delivery are exposed.
 *  - It never calls the sync (the server-side driver keeps the job fresh):
 *    two pollers finalizing the same job could bill a reseller twice.
 *  - It never returns the key, tokens, owner or any account detail.
 * ========================================================================= */

const express = require('express');
const supabase = require('../config/supabase');
const { asyncHandler } = require('../utils/helpers');
const { getConfig } = require('../services/config');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loads a direct-delivery job, or null.
async function directJob(id) {
  if (!UUID.test(String(id || ''))) return null;
  const { data: job } = await supabase
    .from('jobs')
    .select('id, invite, status, boosts_requested, boosts_delivered, owner_id, key_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (!job || !job.key_id) return null;
  const { data: key } = await supabase.from('redeem_keys').select('source').eq('id', job.key_id).maybeSingle();
  return key && key.source === 'sellauth-direct' ? job : null;
}

router.get('/:id', asyncHandler(async (req, res) => {
  const job = await directJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Order not found' });

  // Where a failed order should send the buyer: the seller's support link.
  let supportUrl = '';
  if (job.owner_id) {
    const { data: o } = await supabase.from('users').select('support_url').eq('id', job.owner_id).maybeSingle();
    supportUrl = (o && o.support_url) || '';
  } else {
    supportUrl = (await getConfig('support_server_url')) || process.env.SUPPORT_URL || 'https://discord.gg/ninjasupp';
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    status: job.status === 'completed' || job.status === 'failed' ? job.status : 'running',
    delivered: Number(job.boosts_delivered) || 0,
    requested: Number(job.boosts_requested) || 0,
    invite: job.invite || '',
    startedAt: job.created_at,
    updatedAt: job.updated_at || job.created_at,
    supportUrl: /^https?:\/\//i.test(supportUrl) ? supportUrl : '',
  });
}));

module.exports = router;
module.exports.directJob = directJob;
