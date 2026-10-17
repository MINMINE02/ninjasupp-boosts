'use strict';

/* =========================================================================
 * Public, READ-ONLY progress of a boost — GET /api/status/:id
 * (the page /status/<job id> polls it). It is the "tracking link" a customer can
 * keep after closing the redeem page, and the page of a direct SellAuth order.
 *
 *  - The job id is a random UUID: only someone who got the link has it.
 *  - Only key / direct SellAuth jobs are exposed (never a user's own-token boost).
 *  - It never calls the sync (the server-side driver keeps the job fresh once the
 *    customer's page is closed): two pollers finalizing the same job could bill a
 *    reseller twice.
 *  - It never returns the key, tokens, owner or any account detail.
 * ========================================================================= */

const express = require('express');
const supabase = require('../config/supabase');
const { asyncHandler } = require('../utils/helpers');
const { getConfig } = require('../services/config');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loads a trackable job (a key redeem or a direct delivery), or null.
async function directJob(id) {
  if (!UUID.test(String(id || ''))) return null;
  const { data: job } = await supabase
    .from('jobs')
    .select('id, invite, status, mode, boosts_requested, boosts_delivered, owner_id, key_id, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  return job && job.key_id && job.mode === 'key' ? job : null;
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
