'use strict';

const express = require('express');
const QRCode = require('qrcode');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const TatumService = require('../services/tatum');

const router = express.Router();
const tatum = new TatumService();

const CURRENCY = 'LTC';

// BIP21-style payment URI so wallets can pre-fill address + amount.
function paymentUri(address, ltc) {
  return `litecoin:${address}?amount=${ltc}`;
}

async function makeQr(uri) {
  try {
    return await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  } catch {
    return null;
  }
}

function mapDeposit(d) {
  const ltc = d.amount != null ? Number(d.amount) : null;
  const rate = d.rate != null ? Number(d.rate) : null;
  const received = Number(d.received);
  return {
    id: d.id,
    currency: d.currency,
    address: d.address,
    ltcAmount: ltc,
    usdAmount: d.usd_amount != null ? Number(d.usd_amount) : null,
    rate,
    received,
    receivedUsd: rate != null ? Number((received * rate).toFixed(2)) : null,
    status: d.status,
    forwarded: d.forwarded,
    forwardTxId: d.forward_tx_id,
    txId: d.tx_id,
    paymentUri: ltc != null ? paymentUri(d.address, ltc) : null,
    createdAt: d.created_at,
    completedAt: d.completed_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/wallet — wallet balance + config status.
// ---------------------------------------------------------------------------
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: user } = await supabase
      .from('users')
      .select('balance')
      .eq('id', req.user.id)
      .single();

    // Best-effort live rate so the UI can preview USD -> LTC while typing.
    let ltcRate = null;
    if (tatum.isConfigured()) {
      try { ltcRate = await tatum.getRate('LTC', 'USD'); } catch { ltcRate = null; }
    }

    res.json({
      balance: Number(user?.balance ?? 0),
      currency: 'USD',
      ltcRate,
      topupEnabled: tatum.isConfigured(),
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/wallet/deposit — create a top-up (new unique deposit address).
// ---------------------------------------------------------------------------
router.post(
  '/deposit',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!tatum.isConfigured()) {
      return res.status(503).json({
        error: 'Litecoin top-up is not configured on this server',
      });
    }

    // The user enters the amount in USD; we convert to the exact LTC amount.
    const usdAmount = Number(req.body?.amount);
    if (Number.isNaN(usdAmount) || usdAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid USD amount' });
    }

    let rate;
    try {
      rate = await tatum.getRate('LTC', 'USD');
    } catch (err) {
      return res.status(502).json({ error: `Could not fetch exchange rate: ${err.message}` });
    }
    const ltcAmount = Number((usdAmount / rate).toFixed(8));

    // Next derivation index = max existing + 1 (falling back to the start).
    const { data: last } = await supabase
      .from('deposits')
      .select('derivation_index')
      .order('derivation_index', { ascending: false })
      .limit(1)
      .maybeSingle();

    const index = last ? Number(last.derivation_index) + 1 : tatum.startIndex;

    let address;
    try {
      address = await tatum.getAddress(index);
    } catch (err) {
      return res.status(502).json({ error: `Could not create address: ${err.message}` });
    }

    const { data: deposit, error } = await supabase
      .from('deposits')
      .insert({
        user_id: req.user.id,
        currency: CURRENCY,
        address,
        derivation_index: index,
        amount: ltcAmount,
        usd_amount: usdAmount,
        rate,
        status: 'pending',
      })
      .select('*')
      .single();

    if (error) throw error;

    // Best-effort webhook subscription so we get notified automatically.
    try {
      await tatum.subscribeAddress(address);
    } catch { /* polling still works */ }

    const mapped = mapDeposit(deposit);
    const qr = await makeQr(mapped.paymentUri);
    res.status(201).json({ deposit: mapped, qr });
  })
);

// ---------------------------------------------------------------------------
// GET /api/wallet/deposit/:id — check a deposit (queries Tatum, processes it).
// ---------------------------------------------------------------------------
router.get(
  '/deposit/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: deposit } = await supabase
      .from('deposits')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your deposit' });
    }

    const processed = await processDeposit(deposit);

    const { data: user } = await supabase
      .from('users')
      .select('balance')
      .eq('id', deposit.user_id)
      .single();

    res.json({ deposit: mapDeposit(processed), balance: Number(user?.balance ?? 0) });
  })
);

// ---------------------------------------------------------------------------
// GET /api/wallet/deposits — the user's deposit history. Still-pending
// deposits are checked against the chain first, so the history reflects
// live payment status instead of whatever it said the last time the
// individual deposit box happened to be open and polling.
// ---------------------------------------------------------------------------
router.get(
  '/deposits',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data } = await supabase
      .from('deposits')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    const synced = await Promise.all(
      (data || []).map((d) => (d.status === 'pending' ? processDeposit(d).catch(() => d) : d))
    );

    res.json({ deposits: synced.map(mapDeposit) });
  })
);

// ---------------------------------------------------------------------------
// POST /api/wallet/webhook/tatum — Tatum ADDRESS_TRANSACTION webhook (no auth).
// We re-verify against the chain rather than trusting the payload.
// ---------------------------------------------------------------------------
router.post(
  '/webhook/tatum',
  asyncHandler(async (req, res) => {
    const address = req.body?.address;
    if (address) {
      const { data: deposit } = await supabase
        .from('deposits')
        .select('*')
        .eq('address', address)
        .eq('status', 'pending')
        .maybeSingle();
      if (deposit) {
        try { await processDeposit(deposit); } catch { /* logged below */ }
      }
    }
    // Always 200 so Tatum does not retry indefinitely.
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Core: check the chain for a deposit, credit the user and forward funds.
// ---------------------------------------------------------------------------
async function processDeposit(deposit) {
  if (deposit.status !== 'pending') return deposit;

  let balance;
  try {
    balance = await tatum.getAddressBalance(deposit.address);
  } catch {
    return deposit; // upstream hiccup — leave pending
  }

  const received = balance.received;
  const requested = deposit.amount != null ? Number(deposit.amount) : null;

  // Not enough yet: keep the observed amount but stay pending.
  const enough = requested != null ? received >= requested * 0.95 : received > 0;
  if (!enough) {
    if (received !== Number(deposit.received)) {
      const { data: updated } = await supabase
        .from('deposits')
        .update({ received })
        .eq('id', deposit.id)
        .select('*')
        .single();
      return updated || deposit;
    }
    return deposit;
  }

  // Mark completed and credit the user (guard against double processing).
  const { data: completed } = await supabase
    .from('deposits')
    .update({ status: 'completed', received, completed_at: new Date().toISOString() })
    .eq('id', deposit.id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (!completed) {
    // Someone else already processed it.
    const { data: fresh } = await supabase
      .from('deposits')
      .select('*')
      .eq('id', deposit.id)
      .single();
    return fresh;
  }

  // Credit the user's wallet balance in USD (received LTC * locked rate).
  let rate = deposit.rate != null ? Number(deposit.rate) : null;
  if (rate == null) {
    try { rate = await tatum.getRate('LTC', 'USD'); } catch { rate = 0; }
  }
  const creditUsd = Number((received * rate).toFixed(2));

  const { data: user } = await supabase
    .from('users')
    .select('balance')
    .eq('id', deposit.user_id)
    .single();
  // 4dp, not 2 — the existing balance may carry fractions of a cent from
  // $0.015 captcha charges, and rounding the sum to cents would erase them.
  const newBalance = Number((Number(user?.balance ?? 0) + creditUsd).toFixed(4));
  await supabase.from('users').update({ balance: newBalance }).eq('id', deposit.user_id);

  // Forward the funds to the main address (best-effort).
  let result = completed;
  if (tatum.canForward()) {
    try {
      const { txId } = await tatum.forwardToMain(deposit.derivation_index, received);
      const { data: fwd } = await supabase
        .from('deposits')
        .update({ forwarded: true, forward_tx_id: txId })
        .eq('id', deposit.id)
        .select('*')
        .single();
      result = fwd || completed;
    } catch (err) {
      console.warn('[wallet] forwarding failed for deposit', deposit.id, err.message);
    }
  }

  return result;
}

module.exports = router;
